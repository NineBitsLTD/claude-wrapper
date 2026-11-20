'use strict';
/**
 * Search in the earlier sessions of a project, for the History's search box and the chat's Claude
 * (sessions-mcp.js): an index of what was
 * said — the user's messages, Claude's answers and thinking, the summaries of compactions and a line
 * per tool call (its name and command or file), not what the tools gave back. One file per session
 * in the data dir (.run/session-index/<project dir>/<session>.jsonl, with <session>.json: how far the
 * transcript was read), kept up to date the way the history is read: a transcript only grows, so only
 * what was added since is read. Every window shares it; a lock file keeps two of them from adding
 * the same lines at once.
 *
 * The search is literal: every word of a query has to be there, its ending may differ (a long word
 * is looked for without its last two letters). Several queries (the one typed and its translation)
 * are looked for together.
 *
 *   await search({ dirs, queries, perSession, sessions })  -> { stems, sessions: [{ id, dir, title, updated, count, hits }], total }
 *   await fragment(sessionId, uuid, { before, after })      -> { id, dir, title, updated, at, items } (no uuid: the end)
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { RUN_DIR } = require('./paths');
const sessions = require('./sessions');

const INDEX_DIR = path.join(RUN_DIR, 'session-index');
const TEXT_MAX = 20000; // characters of one message kept in the index
const LOCK_STALE_MS = 2 * 60000;
const SNIPPET_BEFORE = 70;
const SNIPPET_AFTER = 170;
// What a message weighs in the ranking: a summary sums up a lot, a tool call says little.
const ROLE_WEIGHT = { compact: 2, user: 1.2, assistant: 1, thinking: 0.8, tool: 0.4 };

/** A tool's result (most of a transcript's volume): not indexed, told by its bytes. */
function toolResultIn(line) {
  const head = line.subarray(0, 600);
  return head.includes('"type":"user"') && (head.includes('"tool_use_id"') || head.includes('"type":"tool_result"'));
}

/** A tool call as one line: its name and what it works on. */
function describeTool(b) {
  const i = b.input || {};
  const what = i.command || i.file_path || i.notebook_path || i.pattern || i.url || i.query || i.description || (typeof i.prompt === 'string' ? i.prompt.slice(0, 300) : '');
  return `${b.name}${what ? ': ' + String(what).slice(0, 500) : ''}`;
}

const readJson = (file) => fsp.readFile(file, 'utf8').then((t) => JSON.parse(t), () => null);

async function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** Runs `work` holding a lock file; one left by a process that died goes after LOCK_STALE_MS. */
async function withLock(lock, work) {
  for (let i = 0; ; i++) {
    try {
      const fh = await fsp.open(lock, 'wx');
      await fh.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = await fsp.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) { await fsp.rm(lock, { force: true }); continue; }
      if (i > 600) throw new Error('The session index is busy');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try {
    return await work();
  } finally {
    await fsp.rm(lock, { force: true }).catch(() => {});
  }
}

const updating = new Map();

/** Brings one session's index up to date; resolves to its files. */
function update(dir, f) {
  const base = path.join(INDEX_DIR, dir, f.id);
  const files = { docs: base + '.jsonl', meta: base + '.json' };
  const fresh = (m) => m && m.size === f.size && m.mtimeMs === f.mtimeMs;
  if (!updating.has(base)) {
    updating.set(base, (async () => {
      if (fresh(await readJson(files.meta))) return;
      await fsp.mkdir(path.dirname(base), { recursive: true, mode: 0o700 });
      await withLock(base + '.lock', async () => {
        const meta = await readJson(files.meta); // another window may have done it meanwhile
        if (fresh(meta)) return;
        const grown = meta && f.size >= meta.size && await sessions.continuesAt(f.file, meta.offset);
        const at = { offset: grown ? meta.offset : 0 };
        let title = grown ? meta.title : null;
        let firstPrompt = grown ? meta.firstPrompt : null;
        const out = [];
        const add = (u, t, r, x) => { if (x && x.trim()) out.push(JSON.stringify({ u, t, r, x: x.length > TEXT_MAX ? x.slice(0, TEXT_MAX) + '…' : x }) + '\n'); };
        for await (const e of sessions.readJsonl(f.file, { from: at.offset, skip: toolResultIn, at })) {
          if (e.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
          if (e.type === 'custom-title' && e.customTitle) title = e.customTitle;
          if (e.isSidechain) continue;
          if (e.type === 'user' && e.isCompactSummary) {
            const c = e.message?.content;
            add(e.uuid, e.timestamp, 'compact', typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
          } else if (e.type === 'user') {
            const u = sessions.userText(e);
            if (u?.kind === 'text') {
              if (!firstPrompt) firstPrompt = u.text.slice(0, 300);
              add(e.uuid, e.timestamp, 'user', u.text);
            }
          } else if (e.type === 'assistant') {
            for (const b of e.message?.content || []) {
              if (b.type === 'text') add(e.uuid, e.timestamp, 'assistant', b.text);
              else if (b.type === 'thinking') add(e.uuid, e.timestamp, 'thinking', b.thinking);
              else if (b.type === 'tool_use') add(e.uuid, e.timestamp, 'tool', describeTool(b));
            }
          }
        }
        if (grown) await fsp.appendFile(files.docs, out.join(''), { mode: 0o600 });
        else await fsp.writeFile(files.docs, out.join(''), { mode: 0o600 });
        await writeJson(files.meta, { size: f.size, mtimeMs: f.mtimeMs, offset: at.offset, title, firstPrompt });
      });
    })().finally(() => updating.delete(base)));
  }
  return updating.get(base).then(() => files);
}

/** The words of a query, as they are looked for: lower case, a long word without its ending. */
function stemsOf(query) {
  const words = String(query || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 1);
  return [...new Set(words.map((w) => (w.length > 5 ? w.slice(0, -2) : w)))];
}

/** A line of text around the first word found. */
function snippetOf(text, stems) {
  const low = text.toLowerCase();
  const at = Math.min(...stems.map((s) => low.indexOf(s)).filter((i) => i >= 0));
  const start = Math.max(0, at - SNIPPET_BEFORE);
  const end = Math.min(text.length, at + SNIPPET_AFTER);
  return (start ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

function scoreOf(text, stems, phrase) {
  const low = text.toLowerCase();
  let score = 0;
  for (const s of stems) {
    let n = 0;
    for (let i = low.indexOf(s); i >= 0 && n < 5; i = low.indexOf(s, i + s.length)) n++;
    score += n;
  }
  if (phrase && low.includes(phrase)) score += 5;
  return score;
}

/** The sessions of these project dirs, newest first. */
async function sessionFiles(dirs) {
  const all = [];
  for (const dir of dirs) for (const f of await sessions.listSessionFiles(dir)) all.push({ dir, ...f });
  return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Looks for `queries` in the sessions of `dirs`: a message matches when one of the queries has all
 * its words in it. Up to `perSession` hits a session (the best ones, in their order), up to
 * `sessionsMax` sessions (the best first).
 */
async function search({ dirs, queries, perSession = 3, sessionsMax = 40 }) {
  const asked = queries.map((q) => ({ stems: stemsOf(q), phrase: String(q || '').toLowerCase().trim() })).filter((q) => q.stems.length);
  if (!asked.length) return { stems: [], sessions: [], total: 0 };
  const found = [];
  let total = 0;
  for (const f of await sessionFiles(dirs)) {
    const files = await update(f.dir, f);
    const meta = await readJson(files.meta);
    const text = await fsp.readFile(files.docs, 'utf8').catch(() => '');
    const hits = [];
    let pos = 0;
    while (pos < text.length) {
      let nl = text.indexOf('\n', pos);
      if (nl < 0) nl = text.length;
      const line = text.slice(pos, nl);
      const low = line.toLowerCase();
      pos = nl + 1;
      // The raw line first: only a line with every word of some query is parsed.
      const q = asked.findIndex((a) => a.stems.every((s) => low.includes(s)));
      if (q < 0) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      const a = asked[q];
      const low2 = d.x.toLowerCase();
      if (!a.stems.every((s) => low2.includes(s))) continue; // the words were in the keys, not in the text
      hits.push({ uuid: d.u, ts: d.t, role: d.r, query: q, snippet: snippetOf(d.x, a.stems), score: scoreOf(d.x, a.stems, a.phrase) * (ROLE_WEIGHT[d.r] || 1) });
    }
    if (!hits.length) continue;
    total += hits.length;
    const best = [...hits].sort((x, y) => y.score - x.score).slice(0, perSession);
    found.push({
      id: f.id, dir: f.dir, title: meta?.title || (meta?.firstPrompt || '').slice(0, 120) || f.id.slice(0, 8),
      updated: new Date(f.mtimeMs).toISOString(), count: hits.length,
      score: best[0].score + Math.min(hits.length, 10) * 0.2,
      hits: best.sort((x, y) => String(x.ts).localeCompare(String(y.ts))),
    });
  }
  found.sort((x, y) => y.score - x.score || y.updated.localeCompare(x.updated));
  return { stems: [...new Set(asked.flatMap((a) => a.stems))], sessions: found.slice(0, sessionsMax), total };
}

/** The messages around one (`uuid`) of a session, from the index. */
async function fragment(sessionId, uuid, { before = 8, after = 8 } = {}) {
  const file = await sessions.findSessionFile(sessionId);
  if (!file) return null;
  const dir = path.basename(path.dirname(file));
  const st = await fsp.stat(file);
  const files = await update(dir, { file, id: sessionId, size: st.size, mtimeMs: st.mtimeMs });
  const meta = await readJson(files.meta);
  const items = (await fsp.readFile(files.docs, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => {
    try { const d = JSON.parse(l); return { uuid: d.u, ts: d.t, role: d.r, text: d.x }; } catch { return null; }
  }).filter(Boolean);
  const found = uuid ? items.findIndex((d) => d.uuid === uuid) : -1;
  const at = found >= 0 ? found : Math.max(0, items.length - 1); // no place: the session's end
  const start = Math.max(0, at - before);
  return {
    id: sessionId, dir, title: meta?.title || (meta?.firstPrompt || '').slice(0, 120) || sessionId.slice(0, 8),
    updated: new Date(st.mtimeMs).toISOString(), at: at - start, items: items.slice(start, at + after + 1),
  };
}

/** The index of a session that went to the Trash. */
function forget(dir, sessionId) {
  for (const ext of ['jsonl', 'json']) fs.rm(path.join(INDEX_DIR, dir, `${sessionId}.${ext}`), { force: true }, () => {});
}

module.exports = { search, fragment, forget, stemsOf };
