/**
 * Access to Claude Code's on-disk session transcripts: read-only, except for markAsCli,
 * deleteSession (which moves a session to the macOS Trash) and relinkProject (which moves a
 * project's history to the folder the project now lives in: its sessions, its lines of the prompt
 * history ~/.claude/history.jsonl and its entry in ~/.claude.json).
 *
 * Layout (internal to Claude Code, may change between versions):
 *   ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * where <encoded-cwd> is the absolute project path with non-alphanumerics replaced by "-".
 * `--resume` looks for a session only in the dir of the cwd it runs in, so that dir name, not the
 * `cwd` the entries record, decides which folder a project's sessions continue from: a dir renamed
 * after its project moved (relinkProject, or by hand) still records the old path. The entries' `cwd`
 * is used to undo the lossy encoding (projectCwd).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PROMPT_HISTORY = path.join(os.homedir(), '.claude', 'history.jsonl'); // the CLI's ↑ history, `project` per line
const CLI_CONFIG = path.join(os.homedir(), '.claude.json'); // `projects[<path>]`: trust, allowed tools, MCP servers
const SESSION_FILE_RE = /^[0-9a-f-]{36}\.jsonl$/i;

// Parsed-file caches keyed by absolute path; invalidated by mtime.
const summaryCache = new Map();
const projectCwdCache = new Map();

function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

async function* readJsonl(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // Partially written last line or foreign format — skip.
    }
  }
}

async function listSessionFiles(projectDir) {
  const dir = path.join(PROJECTS_DIR, projectDir);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    names
      .filter((n) => SESSION_FILE_RE.test(n))
      .map(async (n) => {
        const file = path.join(dir, n);
        const st = await fsp.stat(file).catch(() => null);
        return st && { file, id: n.slice(0, -6), mtimeMs: st.mtimeMs, size: st.size };
      }),
  );
  return files.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Extracts plain user-typed text from a `user` entry, or null for meta/tool-result entries. */
function userText(entry) {
  if (entry.isMeta || entry.isSidechain) return null;
  const c = entry.message?.content;
  let text = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
      : '';
  if (!text) return null;

  // Slash command invocation: <command-name>/model</command-name> ... <command-args>x</command-args>
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1] || '';
    return { kind: 'command', text: `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]} ${args}`.trim() };
  }
  const stdout = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
  if (stdout) return { kind: 'stdout', text: stdout[1].trim() };

  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text || text.startsWith('<')) return null;
  return { kind: 'text', text };
}

async function summarizeSession(f) {
  const cached = summaryCache.get(f.file);
  if (cached && cached.mtimeMs === f.mtimeMs) return cached.summary;

  let title = null, firstPrompt = null, lastPrompt = null, cwd = null, messages = 0, started = null;
  for await (const e of readJsonl(f.file)) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!started && e.timestamp) started = e.timestamp;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.type === 'user') {
      const u = userText(e);
      if (u && u.kind !== 'stdout') {
        messages++;
        if (!firstPrompt) firstPrompt = u.text;
        lastPrompt = u.text;
      }
    }
  }
  const summary = {
    id: f.id,
    title: title || (firstPrompt || '').slice(0, 120) || '(no messages)',
    firstPrompt: (firstPrompt || '').slice(0, 300),
    lastPrompt: (lastPrompt || '').slice(0, 300),
    messages,
    cwd,
    started,
    updated: new Date(f.mtimeMs).toISOString(),
    size: f.size,
  };
  summaryCache.set(f.file, { mtimeMs: f.mtimeMs, summary });
  return summary;
}

/**
 * Recovers a real path from an encoded project dir name by walking the filesystem:
 * at each level, pick the child whose encoded name is a prefix of what is left.
 * Needed for projects that only have `memory/` and no sessions to read `cwd` from.
 */
async function decodeProjectDir(encoded) {
  async function walk(dir, rest) {
    if (!rest) return dir;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    // Longest match first, so "labi-one" wins over "labi" when both exist.
    const candidates = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => ({ name: e.name, enc: encodeProjectDir(e.name) }))
      .filter(({ enc }) => rest === enc || rest.startsWith(enc + '-'))
      .sort((a, b) => b.enc.length - a.enc.length);
    for (const c of candidates) {
      const found = await walk(path.join(dir, c.name), rest.slice(c.enc.length + 1));
      if (found) return found;
    }
    return null;
  }
  return encoded.startsWith('-') ? walk('/', encoded.slice(1)) : null;
}

const isDir = (p) => fsp.stat(p).then((s) => s.isDirectory(), () => false);

/**
 * The folder a project dir's sessions resume from. The newest sessions' recorded cwds are read
 * (first one of each file), and one whose encoding is the dir name wins, an existing one first. If
 * none is (the dir was renamed after the project moved), the folder is found from the name on
 * disk; failing that, the newest recorded cwd is returned (the project then shows as missing).
 */
async function projectCwd(projectDir, files) {
  const key = projectDir + ':' + (files[0]?.mtimeMs || 0);
  let recorded = projectCwdCache.get(key);
  if (!recorded) {
    recorded = [];
    for (const f of files.slice(0, 3)) {
      for await (const e of readJsonl(f.file)) {
        if (e.cwd) { recorded.push(e.cwd); break; }
      }
    }
    projectCwdCache.set(key, recorded);
  }
  const matching = recorded.filter((c) => encodeProjectDir(c) === projectDir);
  for (const c of matching) if (await isDir(c)) return c;
  if (!matching.length) {
    const found = await decodeProjectDir(projectDir);
    if (found) return found;
  }
  return matching[0] || recorded[0] || null;
}

/** projectCwd for a dir name alone (listing its sessions first). */
async function folderOfProject(projectDir) {
  const files = await listSessionFiles(projectDir);
  return files.length ? projectCwd(projectDir, files) : decodeProjectDir(projectDir);
}

/** All projects Claude Code has sessions for, newest first. */
async function listProjects() {
  let dirs;
  try {
    dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const projects = await Promise.all(
    dirs.filter((d) => d.isDirectory()).map(async (d) => {
      const files = await listSessionFiles(d.name);
      const cwd = files.length ? await projectCwd(d.name, files) : await decodeProjectDir(d.name);
      const exists = cwd ? await isDir(cwd) : false;
      const mtime = files.length ? files[0].mtimeMs : (await fsp.stat(path.join(PROJECTS_DIR, d.name))).mtimeMs;
      return { dir: d.name, cwd, exists, sessions: files.length, updated: new Date(mtime).toISOString() };
    }),
  );
  return projects.filter((p) => p && p.cwd).sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Project dir names whose sessions ran in `cwd` (normally exactly one). */
async function projectDirsFor(cwd) {
  const encoded = encodeProjectDir(cwd);
  const direct = await fsp.stat(path.join(PROJECTS_DIR, encoded)).then((s) => s.isDirectory(), () => false);
  if (direct) return [encoded];
  // Encoding is an assumption — fall back to matching the recorded cwd.
  return (await listProjects()).filter((p) => p.cwd === cwd).map((p) => p.dir);
}

async function listSessions(cwd, limit = 100) {
  const files = [];
  for (const dir of await projectDirsFor(cwd)) files.push(...(await listSessionFiles(dir)));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return Promise.all(files.slice(0, limit).map(summarizeSession));
}

/** Number of saved sessions for `cwd` — only lists files, does not parse them. */
async function countSessions(cwd) {
  let n = 0;
  for (const dir of await projectDirsFor(cwd)) n += (await listSessionFiles(dir)).length;
  return n;
}

async function findSessionFile(sessionId) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const dirs = await fsp.readdir(PROJECTS_DIR).catch(() => []);
  for (const d of dirs) {
    const file = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
    if (await fsp.stat(file).then((s) => s.isFile(), () => false)) return file;
  }
  return null;
}

/** The transcript of one of a session's subagents (<session>/subagents/agent-<id>.jsonl), or null. */
async function subagentFile(sessionId, agentId) {
  if (!/^[\w-]{1,64}$/.test(agentId || '')) return null;
  const file = await findSessionFile(sessionId || '');
  if (!file) return null;
  const sub = path.join(file.slice(0, -'.jsonl'.length), 'subagents', `agent-${agentId}.jsonl`);
  return (await fsp.stat(sub).then((s) => s.isFile(), () => false)) ? sub : null;
}

/**
 * Marks a session as an interactive CLI one: `"entrypoint":"sdk-cli"` -> `"entrypoint":"cli"    `.
 *
 * Claude Code records `sdk-cli` for every `claude -p` run (it even turns CLAUDE_CODE_ENTRYPOINT=cli
 * into `sdk-cli` in print mode) and hides such sessions from the `claude --resume` picker
 * (isHiddenFromSessionPicker). The wrapper's chats are interactive, so after each CLI process of a
 * session exits the marker is patched in place: the replacement has the same length (JSON allows
 * the spaces after the value), so no copy of the file is made and a transcript of any size works
 * (one of 777 MB is past what a string can hold). Transcripts only grow: the bytes already scanned
 * are remembered per file, so later calls read just what was appended. Returns whether it patched.
 */
const MARK_FROM = Buffer.from('"entrypoint":"sdk-cli"');
const MARK_TO = Buffer.from('"entrypoint":"cli"    ');
const MARK_CHUNK = 4 * 1024 * 1024;
const markedUpTo = new Map(); // transcript -> bytes already scanned

async function markAsCli(sessionId) {
  const file = await findSessionFile(sessionId);
  if (!file) return false;
  const fh = await fsp.open(file, 'r+');
  let patched = 0;
  try {
    const { size } = await fh.stat();
    const overlap = MARK_FROM.length - 1; // a marker cut by a chunk's end is found in the next read
    let pos = Math.max(0, Math.min(markedUpTo.get(file) || 0, size) - overlap);
    const buf = Buffer.alloc(Math.min(MARK_CHUNK, Math.max(size - pos, 1)));
    while (pos < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
      if (!bytesRead) break;
      const chunk = buf.subarray(0, bytesRead);
      for (let i = chunk.indexOf(MARK_FROM); i >= 0; i = chunk.indexOf(MARK_FROM, i + MARK_FROM.length)) {
        await fh.write(MARK_TO, 0, MARK_TO.length, pos + i);
        patched++;
      }
      pos += pos + bytesRead >= size ? bytesRead : bytesRead - overlap;
    }
    markedUpTo.set(file, size);
  } finally {
    await fh.close();
  }
  return patched > 0;
}

/**
 * Moves a session to the Trash: its transcript `<id>.jsonl` and the `<id>/` folder next to it
 * (subagent transcripts, tool results), together in one Trash folder "Claude session <id>" so it
 * can be put back by hand. Returns false if there is no such session.
 */
async function deleteSession(sessionId) {
  const file = await findSessionFile(sessionId);
  if (!file) return false;
  const trashDir = path.join(os.homedir(), '.Trash');
  if (process.platform !== 'darwin' || !(await fsp.stat(trashDir).then((s) => s.isDirectory(), () => false))) {
    throw new Error('The Trash is available only on macOS');
  }
  let dest = path.join(trashDir, `Claude session ${sessionId}`);
  for (let i = 2; await fsp.lstat(dest).then(() => true, () => false); i++) dest = path.join(trashDir, `Claude session ${sessionId} ${i}`);
  await fsp.mkdir(dest);
  await fsp.rename(file, path.join(dest, path.basename(file)));
  const extra = file.slice(0, -'.jsonl'.length);
  if (await fsp.stat(extra).then((s) => s.isDirectory(), () => false)) await fsp.rename(extra, path.join(dest, sessionId));
  summaryCache.delete(file);
  return true;
}

/**
 * Simplified transcript for the UI:
 *   { role: 'user' | 'assistant' | 'command' | 'stdout', text }
 *   { role: 'tool', id, name, input, result?, isError?, denied? }
 *   { role: 'compact', trigger, preTokens, postTokens, durationMs, ts, summary? }
 * `denied` is the reason a call was not executed (e.g. "user-rejected", "permission-rule",
 * "automode-blocked"), taken from the entry's `toolDenialKind`.
 */
const HISTORY_RESULT_MAX = 50_000; // characters of a tool result kept for the history view
const historyCache = new Map();     // transcript -> { size, mtimeMs, history }

/**
 * A page of a session's history: the `limit` items before item `before` (default: its end), with
 * `total` and `start` (index of the first returned item) so the page can load earlier ones. A
 * transcript is parsed once per version (size + mtime); the last two parsed are kept.
 */
async function loadHistory(sessionId, { before, limit } = {}) {
  const file = await findSessionFile(sessionId);
  if (!file) return null;
  const st = await fsp.stat(file);
  let cached = historyCache.get(file);
  if (!cached || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
    cached = { size: st.size, mtimeMs: st.mtimeMs, history: await parseHistory(sessionId, file) };
    historyCache.delete(file);
    historyCache.set(file, cached);
    while (historyCache.size > 2) historyCache.delete(historyCache.keys().next().value);
  }
  const h = cached.history;
  const total = h.items.length;
  const end = Math.max(0, Math.min(Number.isInteger(before) ? before : total, total));
  const start = Number.isInteger(limit) && limit > 0 ? Math.max(0, end - limit) : 0;
  // `cwd`: where the session can be resumed now — its project's folder, not the path recorded in
  // the transcript (stale once the project moved). `projectDir` lets the page keep its own folder
  // when that one encodes to the same dir.
  const projectDir = path.basename(path.dirname(file));
  const cwd = (await folderOfProject(projectDir)) || h.cwd;
  return { ...h, cwd, cwdExists: cwd ? await isDir(cwd) : false, projectDir, items: h.items.slice(start, end), total, start };
}

async function parseHistory(sessionId, file) {
  const items = [];
  const tools = new Map();
  let cwd = null;
  let title = null;
  let usage = null; // usage of the last main-agent API message: the size of the context now

  for await (const e of readJsonl(file)) {
    if (!cwd && e.cwd) cwd = e.cwd;
    if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
    if (e.isSidechain) continue;
    if (e.type === 'assistant' && e.message?.usage) usage = e.message.usage;

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata || {};
      items.push({ role: 'compact', trigger: m.trigger, preTokens: m.preTokens, postTokens: m.postTokens, durationMs: m.durationMs, ts: e.timestamp });
      // Until the next answer the context is what the compaction left.
      if (m.postTokens) usage = { input_tokens: m.postTokens };
      continue;
    }
    if (e.type === 'user' && e.isCompactSummary) {
      // The summary that replaced the history: shown under the compaction line, not as a message.
      const last = items[items.length - 1];
      const c = e.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '';
      if (last?.role === 'compact' && text) last.summary = text;
      continue;
    }

    if (e.type === 'user') {
      const c = e.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result') continue;
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          t.result = Array.isArray(b.content)
            ? b.content.map((x) => x.text || `[${x.type}]`).join('\n')
            : String(b.content ?? '');
          if (t.result.length > HISTORY_RESULT_MAX) {
            t.result = t.result.slice(0, HISTORY_RESULT_MAX) + `\n… (truncated: ${Math.round(t.result.length / 1024)} KB in all)`;
          }
          t.isError = !!b.is_error;
          // The denial reason is stored on the entry, which carries a single tool result.
          if (b.is_error && e.toolDenialKind) t.denied = e.toolDenialKind;
        }
      }
      const u = userText(e);
      // uuid: rewinding files / continuing from a message needs it; ts: message times in the UI.
      if (u) items.push({ role: u.kind === 'text' ? 'user' : u.kind, text: u.text, uuid: e.uuid, ts: e.timestamp });
    } else if (e.type === 'assistant') {
      for (const b of e.message?.content || []) {
        if (b.type === 'thinking' && b.thinking?.trim()) {
          // Thinking text is stored only when the run asked for summaries (--thinking-display).
          items.push({ role: 'thinking', text: b.thinking, ts: e.timestamp });
        } else if (b.type === 'text' && b.text.trim()) {
          const last = items[items.length - 1];
          // One API message may be stored as several entries — merge adjacent text.
          if (last?.role === 'assistant') last.text += '\n\n' + b.text;
          else items.push({ role: 'assistant', text: b.text, ts: e.timestamp });
        } else if (b.type === 'tool_use') {
          const t = { role: 'tool', id: b.id, name: b.name, input: b.input };
          tools.set(b.id, t);
          items.push(t);
        }
      }
    }
  }
  return { sessionId, cwd, title, usage, items };
}

/**
 * The entry a user message follows (its parentUuid): continuing a session "from before message
 * X" resumes it at that entry. Returns { found, parent } (parent null: X was the first message).
 */
async function parentOf(sessionId, uuid) {
  const file = await findSessionFile(sessionId);
  if (!file) return { found: false, parent: null };
  for await (const e of readJsonl(file)) {
    if (e.uuid === uuid) return { found: true, parent: e.parentUuid || null };
  }
  return { found: false, parent: null };
}

const PROJECT_DIR_RE = /^-[\w.-]*$/;
const MERGE_COMPARE_MAX = 64 * 1024 * 1024; // larger files with the same name are kept as two

/**
 * Moves a project's history to the folder it now lives in (`newCwd`, a real path):
 * - sessions and memory, so `--resume` finds them from there: ~/.claude/projects/<projectDir> is
 *   renamed to the new folder's encoded name, or merged into that dir when the folder already has
 *   a history. When merging, an entry missing on the other side is moved, folders on both sides are
 *   merged, an identical file is dropped, MEMORY.md (the auto-memory index, a line per memory) gets
 *   the lines it lacks, and any other file with a taken name is kept as
 *   "<name>.from-<projectDir><ext>". The transcripts are not rewritten;
 * - the prompt history: lines of ~/.claude/history.jsonl whose `project` is an old path;
 * - the CLI's per-project settings in ~/.claude.json (mergeProjectConfig); an old path's entry is
 *   removed only when that folder is gone (a copy left behind keeps its settings).
 * Old paths: where the project's sessions started (their first `cwd`) and its folder until now.
 * Also with the dir already named after `newCwd` (renamed by hand): then only the rest moves.
 * Returns { dir, merged, sessions, prompts, settings }.
 */
async function relinkProject(projectDir, newCwd) {
  if (!PROJECT_DIR_RE.test(projectDir || '') || !(await isDir(path.join(PROJECTS_DIR, projectDir)))) {
    throw Object.assign(new Error('Project not found'), { status: 404 });
  }
  const files = await listSessionFiles(projectDir);
  const olds = new Set([await folderOfProject(projectDir)]);
  for (const f of files) {
    for await (const e of readJsonl(f.file)) {
      if (e.cwd) { olds.add(e.cwd); break; }
    }
  }
  olds.delete(newCwd);
  olds.delete(null);
  const target = encodeProjectDir(newCwd);
  let merged = false;
  if (target !== projectDir) {
    const from = path.join(PROJECTS_DIR, projectDir);
    const to = path.join(PROJECTS_DIR, target);
    if (!(await fsp.lstat(to).catch(() => null))) {
      await fsp.rename(from, to);
    } else {
      await mergeDir(from, to, projectDir);
      await fsp.rmdir(from).catch(() => {}); // stays if something could not be moved
      merged = true;
    }
  }
  const prompts = await movePromptHistory(olds, newCwd);
  const settings = await moveProjectConfig(olds, newCwd);
  return { dir: target, merged, sessions: files.length, prompts, settings };
}

/**
 * Replaces a file the CLI writes too, via a temp file renamed over it: `edit(text)` returns the new
 * text, or null to leave it. If the file changed while editing (a running CLI appended or saved),
 * it starts over with the new contents.
 */
async function rewriteShared(file, edit) {
  const real = await fsp.realpath(file).catch(() => null);
  if (!real) return false;
  for (let i = 0; i < 5; i++) {
    const before = await fsp.stat(real);
    const text = await fsp.readFile(real, 'utf8');
    const next = edit(text);
    if (next == null || next === text) return false;
    const tmp = `${real}.ninebits-${process.pid}.tmp`;
    await fsp.writeFile(tmp, next, { mode: before.mode & 0o777 });
    const now = await fsp.stat(real).catch(() => null);
    if (now && now.size === before.size && now.mtimeMs === before.mtimeMs) {
      await fsp.rename(tmp, real);
      return true;
    }
    await fsp.unlink(tmp).catch(() => {});
  }
  throw new Error(`${path.basename(file)} keeps changing — try again`);
}

/** Points the prompt-history lines of the old paths at the new one; returns how many. */
async function movePromptHistory(olds, newCwd) {
  let n = 0;
  // The CLI writes compact JSON, so `"project":"<path>"` with real quotes is the field (inside a
  // string value its quotes would be escaped).
  await rewriteShared(PROMPT_HISTORY, (text) => {
    n = 0;
    let out = text;
    const to = '"project":' + JSON.stringify(newCwd);
    for (const old of olds) {
      const parts = out.split('"project":' + JSON.stringify(old));
      n += parts.length - 1;
      out = parts.join(to);
    }
    return n ? out : null;
  });
  return n;
}

/**
 * The CLI's settings of a project (trust, allowed tools, MCP servers…) from an old path's entry
 * into the new one: missing keys are copied (not the last session's stats), lists are joined, MCP
 * servers missing by name are added, trust holds if either had it.
 */
function mergeProjectConfig(to, from) {
  if (!to) return structuredClone(from);
  for (const [k, v] of Object.entries(from)) {
    if (/^(last|exampleFiles)/.test(k)) continue;
    if (!(k in to)) to[k] = structuredClone(v);
    else if (Array.isArray(v) && Array.isArray(to[k])) {
      const have = new Set(to[k].map((x) => JSON.stringify(x)));
      for (const x of v) if (!have.has(JSON.stringify(x))) to[k].push(structuredClone(x));
    } else if (v && typeof v === 'object' && to[k] && typeof to[k] === 'object') {
      for (const [name, s] of Object.entries(v)) if (!(name in to[k])) to[k][name] = structuredClone(s);
    } else if (k === 'hasTrustDialogAccepted') to[k] = Boolean(to[k] || v);
  }
  return to;
}

/** Moves the old paths' entries of ~/.claude.json `projects` into the new path's; true if any. */
async function moveProjectConfig(olds, newCwd) {
  const gone = new Set();
  for (const old of olds) if (!(await isDir(old))) gone.add(old);
  let moved = false;
  await rewriteShared(CLI_CONFIG, (text) => {
    let cfg;
    try { cfg = JSON.parse(text); } catch { return null; }
    const projects = cfg && cfg.projects;
    moved = false;
    if (!projects || typeof projects !== 'object') return null;
    for (const old of olds) {
      if (!projects[old]) continue;
      projects[newCwd] = mergeProjectConfig(projects[newCwd], projects[old]);
      if (gone.has(old)) delete projects[old];
      moved = true;
    }
    return moved ? JSON.stringify(cfg, null, 2) + (text.endsWith('\n') ? '\n' : '') : null;
  });
  return moved;
}

async function sameContent(a, b, sa, sb) {
  if (sa.size !== sb.size) return false;
  if (sa.size > MERGE_COMPARE_MAX) return false;
  const [x, y] = await Promise.all([fsp.readFile(a), fsp.readFile(b)]);
  return x.equals(y);
}

async function mergeDir(from, to, tag) {
  for (const e of await fsp.readdir(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    const sb = await fsp.lstat(b).catch(() => null);
    if (!sb) { await fsp.rename(a, b); continue; }
    if (e.isDirectory() && sb.isDirectory()) {
      await mergeDir(a, b, tag);
      await fsp.rmdir(a).catch(() => {});
      continue;
    }
    if (e.isFile() && sb.isFile()) {
      const sa = await fsp.stat(a);
      if (await sameContent(a, b, sa, sb)) { await fsp.unlink(a); continue; }
      if (e.name === 'MEMORY.md') {
        const theirs = await fsp.readFile(b, 'utf8');
        const have = new Set(theirs.split('\n'));
        const add = (await fsp.readFile(a, 'utf8')).split('\n').filter((l) => l.trim() && !have.has(l));
        if (add.length) await fsp.appendFile(b, (theirs && !theirs.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
        await fsp.unlink(a);
        continue;
      }
    }
    const ext = e.isFile() ? path.extname(e.name) : '';
    const alt = path.join(to, `${e.name.slice(0, e.name.length - ext.length)}.from-${tag}${ext}`);
    if (!(await fsp.lstat(alt).catch(() => null))) await fsp.rename(a, alt);
  }
}

module.exports = { listProjects, listSessions, countSessions, loadHistory, parentOf, markAsCli, deleteSession, subagentFile, relinkProject, encodeProjectDir, projectDirsFor };
