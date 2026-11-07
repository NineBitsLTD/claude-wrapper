#!/usr/bin/env node
/**
 * The `claude` CLI wrapper behind the Claude Wrapper VS Code extension (copied from Claude-AI's
 * server; the test API, image generation, the Cloudflare tunnel, the terminal, the file translation,
 * the vendored editor/terminal libraries, the built-in voice (Python Silero) and speech recognition
 * (Swift helper) were left out; voice will come from VS Code).
 *
 * Routes (/api/...) for the chat page and the extension's side bar: prompts go to `claude -p`, its
 * NDJSON events (stream-json output format) stream back; projects, history, processes, subagents,
 * file operations.
 *
 * Two ways to run it:
 * - In the extension (the normal way): extension.js requires this module, calls start() and passes
 *   requests to handleRequest through inproc.js — no HTTP, no port; the chat page in the webview
 *   reaches the routes through its fetch shim. Nothing process-wide is touched here (VS Code's
 *   extension host is shared with other extensions): no .env, no signal handlers, no env edits.
 * - Standalone, for working on the page in a browser:
 *     node server.js                  # http://127.0.0.1:3000, settings from .env in the data dir
 *     PORT=4000 CLAUDE_CWD=~/project node server.js
 *
 * No external dependencies — Node 18+ only.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const STANDALONE = require.main === module;
// Told by /api/info.
const SERVER_VERSION = (() => { try { return require('../package.json').version; } catch { return '0'; } })();

/**
 * Standalone only: settings from .env in the data dir (Node's built-in loader). Loaded before the
 * local modules below, which read their settings when they load; variables already set in the shell
 * win. Names that came from the file are removed from process.env once everything is configured, so
 * they don't reach the claude processes.
 */
const { ENV_FILE, RUN_DIR, fromData } = require('./paths');
const envFromFile = !STANDALONE ? [] : (() => {
  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(ENV_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`Could not read ${ENV_FILE}: ${e.message}`);
  }
  return Object.keys(process.env).filter((k) => !before.has(k));
})();

const sessions = require('./sessions');
const { ProcessRegistry, cleanEnv } = require('./processes');
const cliModels = require('./cli-models');
const agentTasks = require('./agent-tasks');
const { handleFsOp, handleUpload } = require('./fileops');
const { handleSearch } = require('./search');
const { readAudioTags, readAudioCover } = require('./audio-tags');
const cliControl = require('./cli-control');
const fileSearch = require('./file-search');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
// Optional HTTPS listener (same app) next to the HTTP one.
const HTTPS_PORT = Number(process.env.CLAUDE_WEB_HTTPS_PORT) || 0;
const TLS_CERT = fromData(process.env.CLAUDE_WEB_TLS_CERT || '.run/tls/localhost.pem');
const TLS_KEY = fromData(process.env.CLAUDE_WEB_TLS_KEY || '.run/tls/localhost-key.pem');
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
// The default project folder (the page names its own): standalone the current one, in VS Code home.
const WORK_DIR = expandHome(process.env.CLAUDE_CWD || (STANDALONE ? process.cwd() : os.homedir()));
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const I18N_JS = path.join(__dirname, 'public', 'i18n.js');
// Subagents of the main agent in the background (CLAUDE_CODE_FORK_SUBAGENT=1 for the runs).
const BACKGROUND_AGENTS = process.env.CLAUDE_WEB_BACKGROUND_AGENTS !== '0';
// How long a chat's claude process waits for the next message after an answer (0 = exit at once).
// Keeping it alive keeps what lives in it: MCP servers (the Chrome tab group), background shells.
// Over an hour by default: the CLI compacts a big idle context at 90% of the prompt cache's hour
// (idle compaction), which needs the process alive then.
const IDLE_KEEP_MS = Math.max(0, Number(process.env.CLAUDE_WEB_IDLE_KEEP_MIN ?? 65) || 0) * 60000;

/**
 * Active CLI runs: runId -> { res, pending: Map<requestId, resolve> }.
 * `res` is the browser's NDJSON stream; `pending` holds unanswered permission prompts.
 */
const runs = new Map();

// Persistent list of Claude Code's processes (see processes.js). No serverPid: in the extension
// this process is VS Code's extension host, whose other children (other extensions') aren't ours.
const registry = new ProcessRegistry({ serverPid: null });

// Everything above has read its settings: keep .env values out of child processes.
for (const name of envFromFile) delete process.env[name];

// Only these values are passed to --permission-mode.
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk']);
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 7 * 1024 * 1024; // ~5 MB of image data, the API's per-image limit

/** Validated image attachments -> API content blocks (or an error message). */
function imageBlocks(images) {
  if (images == null) return { blocks: [] };
  if (!Array.isArray(images) || images.length > MAX_IMAGES) return { error: `No more than ${MAX_IMAGES} images` };
  const blocks = [];
  for (const im of images) {
    if (!IMAGE_TYPES.has(im?.media_type) || typeof im.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(im.data)) return { error: 'Unsupported image' };
    if (im.data.length > MAX_IMAGE_B64) return { error: 'The image is larger than 5 MB' };
    blocks.push({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } });
  }
  return { blocks };
}

/** Environment of every claude process the page starts: process tracking + file checkpoints. */
function cliEnv(runId) {
  // Checkpoints make "rewind files to this message" possible (rewind_files control request).
  return { ...registry.childEnv(runId), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' };
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Rejects requests from foreign origins so that arbitrary websites
 * cannot drive the local CLI through the user's browser (CSRF / DNS rebinding).
 */
function isTrustedRequest(req) {
  if (req.inproc) return true; // from the extension (inproc.js): no network involved
  // The page may be opened over HTTP (PORT) or HTTPS (HTTPS_PORT); each port has its own scheme.
  const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (HTTPS_PORT) origins.push(`https://127.0.0.1:${HTTPS_PORT}`, `https://localhost:${HTTPS_PORT}`);
  const allowedHosts = origins.map((o) => o.replace(/^https?:\/\//, ''));
  if (!allowedHosts.includes(req.headers.host)) return false;
  const origin = req.headers.origin;
  if (origin && !origins.includes(origin)) return false;
  return true;
}

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}



function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024 * 1024); // images come inline as base64
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const images = imageBlocks(body.images);
  if (images.error) return sendJson(res, 400, { error: images.error });
  if (!prompt && !images.blocks.length) return sendJson(res, 400, { error: 'Empty prompt' });

  const cwd = await resolveDir(body.cwd);
  if (!cwd) return sendJson(res, 400, { error: `Folder not found: ${body.cwd}` });

  // Streaming input: stdin stays open, so more user messages can be written while Claude works.
  // The CLI delivers them mid-turn (after the current tool call), like the interactive terminal.
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--replay-user-messages',
    // Let Claude drive the user's own Chrome through the Claude in Chrome extension.
    '--chrome',
  ];

  if (body.sessionId) {
    if (!SESSION_ID_RE.test(body.sessionId)) return sendJson(res, 400, { error: 'Bad sessionId' });
    if (body.forkAt) {
      // "Continue from before this message": a new session with the history up to the entry the
      // message followed. The first message has no such entry: then it is simply a new chat.
      if (!SESSION_ID_RE.test(body.forkAt)) return sendJson(res, 400, { error: 'Bad forkAt' });
      const { found, parent } = await sessions.parentOf(body.sessionId, body.forkAt);
      if (!found) return sendJson(res, 404, { error: 'The message is not found in the session' });
      if (parent) args.push('--resume', body.sessionId, '--fork-session', '--resume-session-at', parent);
    } else {
      args.push('--resume', body.sessionId);
    }
  }
  if (body.permissionMode) {
    if (!PERMISSION_MODES.has(body.permissionMode)) return sendJson(res, 400, { error: 'Bad permissionMode' });
    args.push('--permission-mode', body.permissionMode);
  }
  if (typeof body.model === 'string' && /^[\w.\-\[\]]{1,64}$/.test(body.model)) {
    args.push('--model', body.model);
  }
  // Effort goes as the flag: the settings key ignores "max". Without it the CLI's settings decide.
  if (body.effort) {
    if (!EFFORT_LEVELS.has(body.effort)) return sendJson(res, 400, { error: 'Bad effort' });
    args.push('--effort', body.effort);
  }

  // Permission prompts come as can_use_tool control requests on stdout (run.onCanUseTool below).
  args.push('--permission-prompt-tool', 'stdio');
  // Summaries of Claude's thinking, shown on the page (its setting "show thinking").
  if (body.thinking === true) args.push('--thinking-display', 'summarized');
  const runId = crypto.randomUUID();
  // Ultracode: standing orchestration through the Workflow tool, on top of any effort level.
  if (body.ultracode === true) args.push('--settings', JSON.stringify({ ultracode: true }));

  // Arguments are passed as an array (no shell), so the prompt cannot inject commands.
  // childEnv() makes every shell command of the run report its process group (see processes.js).
  // CLAUDE_CODE_FORK_SUBAGENT=1 runs the main agent's subagents in the background, as the terminal,
  // the desktop app and VS Code do: messages typed meanwhile reach Claude between its tool calls.
  const env = { ...cliEnv(runId), ...(BACKGROUND_AGENTS ? { CLAUDE_CODE_FORK_SUBAGENT: '1' } : {}) };
  const child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {}); // EPIPE if the CLI exits while we write

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  // queued: user messages written to stdin that the CLI has not echoed back (replayed) yet.
  // agents: background subagents still working; idle: the last turn ended with a `result`;
  // waiting: idle with nothing left to do, kept open for the next message (wrapper_idle sent).
  const run = { res, cwd, prompt: prompt.slice(0, 200), pending: new Map(), cliRequests: new Map(), child, queued: 0, agents: 0, idle: false, waiting: false, accepting: true, idleTimer: null, sessionId: body.forkAt ? null : body.sessionId || null };
  cliControl.attach(run);
  run.onCanUseTool = (request, requestId) => askPermission(run, request, requestId);
  run.onElicitation = (request, requestId) => askElicitation(run, request, requestId);
  run.onCancelRequest = (requestId) => run.pending.get(run.cliRequests.get(requestId))?.({ behavior: 'cancelled' });
  runs.set(runId, run);
  res.write(JSON.stringify({ type: 'wrapper_run', runId, pid: child.pid || null }) + '\n');
  // The Agent SDK's handshake, sent before the message. perTaskStopAffordance: the page stops
  // single tasks itself (stop_task), so an interrupt only ends the turn and background agents keep
  // working. The answer carries the slash commands with descriptions, the model list and the
  // output styles (with the current one).
  // forwardNestedSubagentToolCalls: the tool calls of agents that subagents start come too (with
  // parent_tool_use_id), as in VS Code, for the tool cards and the subagents view.
  run.control({ subtype: 'initialize', perTaskStopAffordance: true, forwardNestedSubagentToolCalls: true }).then((r) => {
    cliModels.update(r.models);
    const commands = (Array.isArray(r.commands) ? r.commands : [])
      .filter((c) => c && typeof c.name === 'string')
      .map((c) => ({ name: c.name, description: c.description || '', argumentHint: c.argumentHint || '' }));
    if (!res.writableEnded) {
      res.write(JSON.stringify({
        type: 'wrapper_init', commands, models: cliModels.list(), defaultModel: cliModels.defaultModel(),
        outputStyle: r.output_style, outputStyles: Array.isArray(r.available_output_styles) ? r.available_output_styles : [],
      }) + '\n');
    }
  }, (e) => console.warn(`[chat] initialize: ${e.message}`));
  writeUserMessage(run, prompt, images.blocks);

  // The registry ties the run's processes to it and to its project folder (/api/processes?cwd=).
  if (child.pid) {
    registry
      .register(child.pid, { kind: 'claude', runId, cwd, prompt: prompt.slice(0, 200), sessionId: body.sessionId || null })
      .catch((e) => console.error('[processes] register failed:', e.message));
  }

  if (child.pid) {
    registry
      .register(child.pid, { kind: 'claude', runId, cwd, prompt: prompt.slice(0, 200), sessionId: body.sessionId || null })
      .catch((e) => console.error('[processes] register failed:', e.message));
  }

  // stdout is NDJSON: forwarded line by line, except the control traffic of run.control().
  const decoder = new StringDecoder('utf8');
  let lineBuf = '';
  let sessionKnown = false;
  child.stdout.on('data', (chunk) => {
    lineBuf += decoder.write(chunk);
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        res.write(line + '\n');
        continue;
      }
      if (cliControl.onEvent(run, ev)) continue;
      res.write(line + '\n');
      if (!sessionKnown && ev.session_id) {
        sessionKnown = true;
        run.sessionId = ev.session_id;
        registry.annotate(child.pid, { sessionId: ev.session_id });
      }
      onCliEvent(run, ev);
      agentTasks.onEvent(runId, run, ev);
    }
  });

  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c.toString('utf8')));

  child.on('error', (err) => {
    res.write(JSON.stringify({ type: 'wrapper_error', message: `Failed to start "${CLAUDE_BIN}": ${err.message}` }) + '\n');
    res.end();
  });

  child.on('close', (code) => {
    registry.runFinished();
    agentTasks.onRunEnd(runId);
    // Show the chat in `claude --resume` of a terminal too (see sessions.markAsCli).
    if (run.sessionId) sessions.markAsCli(run.sessionId).catch((e) => console.warn(`markAsCli: ${e.message}`));
    if (code !== 0 && stderr.trim()) {
      res.write(JSON.stringify({ type: 'wrapper_error', message: stderr.trim(), code }) + '\n');
    }
    res.end();
  });

  // Client pressed "Stop" or closed the tab — deny open prompts and terminate the CLI process.
  res.on('close', () => {
    clearTimeout(run.idleTimer);
    run.accepting = false;
    for (const resolve of run.pending.values()) resolve({ behavior: 'deny', message: 'Run was stopped by the user.' });
    runs.delete(runId);
    if (child.exitCode === null) child.kill('SIGTERM');
  });
}

/** Writes a user message; returns its uuid (the CLI keeps it: replays name it, cancel_async_message takes it). */
function writeUserMessage(run, text, imageBlocks = []) {
  // Slash commands are executed, not echoed back as a replay — don't wait for one.
  if (!text.startsWith('/') || imageBlocks.length) run.queued++;
  const content = imageBlocks.length ? [...imageBlocks, ...(text ? [{ type: 'text', text }] : [])] : text;
  const uuid = crypto.randomUUID();
  run.child.stdin.write(JSON.stringify({ type: 'user', uuid, parent_tool_use_id: null, message: { role: 'user', content } }) + '\n');
  return uuid;
}

/**
 * An MCP server asks the user for input (elicitation): a form from its JSON schema, or a page to
 * open (mode "url"). The page answers through /api/elicitation; resolves with the CLI's
 * { action: accept | decline | cancel, content }, or null when the CLI withdrew the request.
 */
function askElicitation(run, request, requestId) {
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    run.pending.set(id, resolve);
    run.cliRequests.set(requestId, id);
    run.res.write(JSON.stringify({
      type: 'elicitation_request', id, server: request.mcp_server_name, message: request.message, mode: request.mode || 'form',
      url: request.url, schema: request.requested_schema, order: request.property_order, title: request.title, description: request.description,
    }) + '\n');
  }).then((d) => {
    run.pending.delete(id);
    run.cliRequests.delete(requestId);
    const action = ['accept', 'decline', 'cancel'].includes(d.action) ? d.action : d.behavior === 'cancelled' ? null : 'cancel';
    run.res.write(JSON.stringify({ type: 'elicitation_resolved', id, action: action || 'cancelled' }) + '\n');
    if (!action) return null;
    return action === 'accept' && d.content ? { action, content: d.content } : { action };
  });
}

/** The page's answer to an MCP form: { runId, id, action, content } (content: flat values). */
async function handleElicitationAnswer(req, res) {
  let body;
  try { body = await readJsonBody(req, 256 * 1024); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  const resolve = runs.get(body.runId)?.pending.get(body.id);
  if (!resolve) return sendJson(res, 404, { error: 'Form not found or already answered' });
  if (!['accept', 'decline', 'cancel'].includes(body.action)) return sendJson(res, 400, { error: 'Bad action' });
  const c = body.content;
  const flat = (v) => ['string', 'number', 'boolean'].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
  if (c != null && (typeof c !== 'object' || Array.isArray(c) || !Object.values(c).every(flat))) return sendJson(res, 400, { error: 'Bad content' });
  resolve({ action: body.action, content: body.action === 'accept' ? c || {} : undefined });
  sendJson(res, 200, { ok: true });
}

/**
 * A can_use_tool control request of the CLI (--permission-prompt-tool stdio): asks the page
 * (permission_request, answered through /api/permission) and resolves with the CLI's
 * PermissionResult. "Always allow" may only add rules the CLI itself suggested (as in VS Code).
 */
function askPermission(run, request, requestId) {
  const id = crypto.randomUUID();
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  return new Promise((resolve) => {
    run.pending.set(id, resolve);
    run.cliRequests.set(requestId, id);
    run.res.write(JSON.stringify({
      type: 'permission_request', id, tool_name: request.tool_name, input: request.input, tool_use_id: request.tool_use_id,
      agent_id: request.agent_id, title: request.title, description: request.description, reason: request.decision_reason,
      blocked_path: request.blocked_path, suggestions,
    }) + '\n');
  }).then((decision) => {
    run.pending.delete(id);
    run.cliRequests.delete(requestId);
    run.res.write(JSON.stringify({ type: 'permission_resolved', id, behavior: decision.behavior }) + '\n');
    if (decision.behavior === 'cancelled') return null; // withdrawn by the CLI: no answer is expected
    if (decision.behavior !== 'allow') return { behavior: 'deny', message: decision.message || 'The user denied this action in the web UI.' };
    const known = new Set(suggestions.map((x) => JSON.stringify(x)));
    const updates = (decision.updatedPermissions || []).filter((x) => known.has(JSON.stringify(x)));
    // The CLI expects updatedInput on allow: the page's version (answers to AskUserQuestion) or the original.
    return { behavior: 'allow', updatedInput: decision.updatedInput || request.input || {}, ...(updates.length ? { updatedPermissions: updates } : {}) };
  });
}

/** Closes stdin so the CLI exits once it has nothing left to do. */
function finishInput(run) {
  clearTimeout(run.idleTimer);
  if (!run.accepting) return;
  run.accepting = false;
  run.waiting = false;
  run.child.stdin.end();
}

/** Nothing left to do: keep the process for the next message for IDLE_KEEP_MS, then let it exit. */
function waitForNext(run) {
  clearTimeout(run.idleTimer);
  if (!IDLE_KEEP_MS || !run.accepting) return finishInput(run);
  run.waiting = true;
  run.idleTimer = setTimeout(() => finishInput(run), IDLE_KEEP_MS);
  run.res.write(JSON.stringify({ type: 'wrapper_idle', until: Date.now() + IDLE_KEEP_MS }) + '\n');
}

/** Lets a waiting run in this session exit; resolves once its process is gone. */
function releaseWaiting(sessionId) {
  const run = [...runs.values()].find((r) => r.sessionId === sessionId && r.waiting && r.child.exitCode === null);
  if (!run) return Promise.resolve();
  const gone = new Promise((resolve) => run.child.once('close', resolve));
  finishInput(run);
  setTimeout(() => { if (run.child.exitCode === null) run.child.kill('SIGTERM'); }, 5000);
  return gone;
}

/**
 * Lifecycle of a streaming run: every user message we write is echoed back as a replay when
 * the CLI takes it. After a `result`, stdin is closed if nothing is waiting; otherwise the CLI
 * continues with the queued message (a safety timer closes stdin if it never picks it up).
 * While background subagents work stdin stays open too: the user can still write, and the CLI
 * starts a new turn with each subagent's result. Background shell commands don't count — a dev
 * server must not keep the run open forever. With nothing left, the process still waits
 * IDLE_KEEP_MS for the next message (`wrapper_idle`), which the page sends with /api/chat/send.
 */
function onCliEvent(run, ev) {
  if (ev.type === 'system' && ev.subtype === 'background_tasks_changed') {
    run.agents = (ev.tasks || []).filter((t) => t.task_type === 'local_agent').length;
    // The last agent is done while idle: its result normally starts a turn; if none comes, finish.
    if (run.idle && !run.waiting && run.agents === 0 && run.queued === 0) {
      clearTimeout(run.idleTimer);
      run.idleTimer = setTimeout(() => waitForNext(run), 15000);
    }
    return;
  }
  if (ev.type === 'user' && ev.isReplay) {
    run.queued = Math.max(0, run.queued - 1);
    run.idle = run.waiting = false;
    clearTimeout(run.idleTimer);
  } else if (ev.type === 'result') {
    run.idle = true;
    run.waiting = false;
    clearTimeout(run.idleTimer);
    if (run.queued > 0) run.idleTimer = setTimeout(() => finishInput(run), 15000);
    else if (run.agents === 0) waitForNext(run);
  } else if (run.idle && (ev.type === 'assistant' || ev.type === 'stream_event')) {
    run.idle = run.waiting = false; // a new turn (e.g. with a subagent's result)
    clearTimeout(run.idleTimer);
  }
}

/** Adds a user message to a running claude process (typed while Claude is working). */
async function handleChatSend(req, res) {
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024 * 1024);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const images = imageBlocks(body.images);
  if (images.error) return sendJson(res, 400, { error: images.error });
  if (!prompt && !images.blocks.length) return sendJson(res, 400, { error: 'Empty prompt' });
  const run = runs.get(body.runId);
  // The run already finished (or is finishing): the client sends the message as a new run.
  if (!run || !run.accepting || !run.child.stdin.writable) return sendJson(res, 409, { error: 'Run is not accepting messages' });
  if (run.waiting) {
    // A slash command is not replayed: keep the process alive while it runs, its `result` resets this.
    run.waiting = false;
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(() => finishInput(run), IDLE_KEEP_MS);
  }
  const uuid = writeUserMessage(run, prompt, images.blocks);
  sendJson(res, 200, { ok: true, queued: run.queued, uuid });
}

/** Lets a run waiting for the next message exit now: { runId }. */
async function handleChatFinish(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  const run = runs.get(body.runId);
  if (!run) return sendJson(res, 404, { error: 'Not found' });
  finishInput(run);
  sendJson(res, 200, { ok: true });
}

/** apply_flag_settings from the page may change only { effortLevel: level|null, ultracode: bool }. */
function flagSettings(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const keys = Object.keys(s);
  if (!keys.length || keys.some((k) => k !== 'effortLevel' && k !== 'ultracode')) return null;
  if ('effortLevel' in s && s.effortLevel !== null && !EFFORT_LEVELS.has(s.effortLevel)) return null;
  if ('ultracode' in s && typeof s.ultracode !== 'boolean') return null;
  return s;
}

const TASK_ID_RE = /^[\w.:-]{1,128}$/;

/**
 * update_settings may set the output style only (the CLI's own allowlist for localSettings, which
 * it saves in the project's .claude/settings.local.json and applies at once); reload_plugins holds
 * back unless forced when applying would change the tools the prompt cache depends on.
 */
function checkedSettingsRequest(r) {
  if (r.subtype === 'reload_plugins') return { subtype: 'reload_plugins', hold_on_cache_impact: r.force !== true };
  const style = r.settings?.outputStyle;
  if (typeof style !== 'string' || !/^[\w .:-]{1,100}$/.test(style)) return null;
  return { subtype: 'update_settings', source: 'localSettings', settings: { outputStyle: style } };
}

// Plan limits for the header meter (GET /api/usage): one get_usage for every tab, cached. With a
// live chat process it is a control request to it (a minute's cache); otherwise a short CLI
// process in the API's empty folder (no project hooks), at most every 5 minutes. No model call
// either way; skip_behaviors spares the scan of a week of transcripts.
const USAGE_TTL_LIVE_MS = 60_000;
const USAGE_TTL_IDLE_MS = 5 * 60_000;
let usageCache = null; // { at, data }
let usageReading = null;

function planUsage(fresh) {
  const live = [...runs.values()].find((r) => r.child.exitCode === null && r.child.stdin.writable);
  const ttl = live ? USAGE_TTL_LIVE_MS : USAGE_TTL_IDLE_MS;
  if (!fresh && usageCache && Date.now() - usageCache.at < ttl) return Promise.resolve(usageCache.data);
  usageReading ??= (async () => {
    try {
      const request = { subtype: 'get_usage', skip_behaviors: true };
      const r = live
        ? await live.control(request)
        : (await cliControl.oneShot({ claudeBin: CLAUDE_BIN, cwd: path.join(RUN_DIR, 'api-sandbox'), requests: [request], env: cleanEnv() }))[0];
      if (r.error) throw new Error(r.error);
      const data = { subscription_type: r.subscription_type, rate_limits_available: r.rate_limits_available, rate_limits: r.rate_limits };
      usageCache = { at: Date.now(), data };
      return data;
    } finally {
      usageReading = null;
    }
  })();
  return usageReading;
}
// /btw may take a while: the CLI itself gives a side question up to 11 minutes.
const SIDE_QUESTION_MS = 11 * 60_000;

/** side_question ({ question, history: [{ question, response }] }) checked, or null. */
function sideQuestion(r) {
  if (typeof r.question !== 'string' || !r.question.trim() || r.question.length > 20000) return null;
  const history = Array.isArray(r.history) ? r.history.slice(-20) : [];
  if (history.some((h) => typeof h?.question !== 'string' || typeof h?.response !== 'string')) return null;
  return { subtype: 'side_question', question: r.question, ...(history.length ? { history: history.map(({ question, response }) => ({ question, response })) } : {}) };
}

/**
 * Control of a running chat: { runId, request: { subtype, ... } } — interrupt (stop the turn but
 * keep the session), set_model / set_permission_mode / apply_flag_settings (effort, ultracode;
 * take effect immediately), context usage, get_settings (only the values the CLI applies),
 * tasks (stop_task, background_tasks, get_task_output).
 */
async function handleChatControl(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  let request = body.request || {};
  if (!cliControl.RUN_SUBTYPES.has(request.subtype)) return sendJson(res, 400, { error: 'Unsupported request' });
  if (request.subtype === 'set_permission_mode' && !PERMISSION_MODES.has(request.mode)) return sendJson(res, 400, { error: 'Bad mode' });
  if (request.subtype === 'set_model' && request.model != null && !/^[\w.\-\[\]]{1,64}$/.test(request.model)) return sendJson(res, 400, { error: 'Bad model' });
  if (request.subtype === 'apply_flag_settings') {
    const settings = flagSettings(request.settings);
    if (!settings) return sendJson(res, 400, { error: 'Bad settings' });
    request = { subtype: 'apply_flag_settings', settings };
  }
  if (request.subtype === 'get_settings') request = { subtype: 'get_settings' };
  if (request.subtype === 'stop_task' || request.subtype === 'get_task_output') {
    if (!TASK_ID_RE.test(request.task_id || '')) return sendJson(res, 400, { error: 'Bad task_id' });
    request = { subtype: request.subtype, task_id: request.task_id };
  }
  if (request.subtype === 'background_tasks') {
    if (request.tool_use_id != null && !TASK_ID_RE.test(request.tool_use_id)) return sendJson(res, 400, { error: 'Bad tool_use_id' });
    request = { subtype: 'background_tasks', ...(request.tool_use_id ? { tool_use_id: request.tool_use_id } : {}) };
  }
  if (request.subtype === 'cancel_async_message') {
    if (!SESSION_ID_RE.test(request.message_uuid || '')) return sendJson(res, 400, { error: 'Bad message_uuid' });
    request = { subtype: 'cancel_async_message', message_uuid: request.message_uuid };
  }
  if (request.subtype === 'side_question') {
    request = sideQuestion(request);
    if (!request) return sendJson(res, 400, { error: 'Bad question' });
  }
  if (request.subtype === 'update_settings' || request.subtype === 'reload_plugins') {
    request = checkedSettingsRequest(request);
    if (!request) return sendJson(res, 400, { error: 'Bad settings' });
  }
  if (['mcp_toggle', 'mcp_reconnect', 'mcp_authenticate'].includes(request.subtype)) {
    if (typeof request.serverName !== 'string' || !request.serverName || request.serverName.length > 200) return sendJson(res, 400, { error: 'Bad serverName' });
    if (request.subtype === 'mcp_toggle' && typeof request.enabled !== 'boolean') return sendJson(res, 400, { error: 'Bad enabled' });
    request = { subtype: request.subtype, serverName: request.serverName, ...(request.subtype === 'mcp_toggle' ? { enabled: request.enabled } : {}) };
  }
  const run = runs.get(body.runId);
  if (!run || run.child.exitCode !== null) return sendJson(res, 409, { error: 'No active run' });
  try {
    const r = await run.control(request, request.subtype === 'side_question' ? SIDE_QUESTION_MS : undefined);
    // A withdrawn message will never be replayed.
    if (request.subtype === 'cancel_async_message' && r.cancelled) run.queued = Math.max(0, run.queued - 1);
    // The full answer carries the merged settings (env, permissions…): the page gets only `applied`.
    sendJson(res, 200, request.subtype === 'get_settings' ? { applied: r.applied || {} } : r);
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

/**
 * Control of a saved session while no chat runs in it: { sessionId, cwd, request } — rewind files
 * to a message (dry_run first to preview), context usage, generate a title / rename, MCP status.
 * A short claude process resumes the session for it (no prompt, no model call except titles).
 */
async function handleSessionControl(req, res) {
  let body;
  try { body = await readJsonBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  let request = body.request || {};
  if (!cliControl.SESSION_SUBTYPES.has(request.subtype)) return sendJson(res, 400, { error: 'Unsupported request' });
  if (request.subtype === 'side_question') {
    request = sideQuestion(request);
    if (!request) return sendJson(res, 400, { error: 'Bad question' });
  }
  if (request.subtype === 'update_settings') {
    request = checkedSettingsRequest(request);
    if (!request) return sendJson(res, 400, { error: 'Bad settings' });
  }
  // Settings-based views and the style belong to the project: no session is resumed for them.
  if (['list_permission_rules', 'get_hooks_listing', 'get_status', 'update_settings', 'get_settings'].includes(request.subtype)) body.sessionId = null;
  if (request.subtype === 'get_settings') request = { subtype: 'get_settings' };
  if (request.subtype === 'rewind_files' && !SESSION_ID_RE.test(request.user_message_id || '')) return sendJson(res, 400, { error: 'Bad user_message_id' });
  if (request.subtype === 'rename_session' && (typeof request.title !== 'string' || !request.title.trim() || request.title.length > 200)) return sendJson(res, 400, { error: 'Bad title' });
  if (body.sessionId && !SESSION_ID_RE.test(body.sessionId)) return sendJson(res, 400, { error: 'Bad sessionId' });
  if (!body.sessionId && !cliControl.PROJECT_SUBTYPES.has(request.subtype)) return sendJson(res, 400, { error: 'sessionId required' });
  const cwd = await resolveDir(body.cwd);
  if (!cwd) return sendJson(res, 400, { error: 'Folder not found' });
  // A second process writing to a session that is being answered would interleave its history.
  // A process waiting for the next message in it takes the request itself.
  const live = [...runs.values()].find((r) => r.sessionId && r.sessionId === body.sessionId && r.child.exitCode === null);
  if (live?.waiting) {
    try {
      const r = await live.control(request, request.subtype === 'side_question' ? SIDE_QUESTION_MS : undefined);
      return sendJson(res, 200, request.subtype === 'get_settings' ? settingsDefaults(r) : r);
    } catch (e) {
      return sendJson(res, 422, { error: e.message });
    }
  }
  if (live && request.subtype !== 'get_context_usage') return sendJson(res, 409, { error: 'Claude is working in this session now — wait for the answer to end' });
  try {
    const [r] = await cliControl.oneShot({
      claudeBin: CLAUDE_BIN, cwd, sessionId: body.sessionId, requests: [request], env: { ...cleanEnv(), CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true' },
      ...(request.subtype === 'side_question' ? { timeoutMs: SIDE_QUESTION_MS } : {}),
    });
    if (body.sessionId) sessions.markAsCli(body.sessionId).catch(() => {}); // the resumed process may have appended entries
    if (r.error) return sendJson(res, 422, { error: r.error });
    sendJson(res, 200, request.subtype === 'get_settings' ? settingsDefaults(r) : r);
  } catch (e) {
    sendJson(res, 502, { error: e.message });
  }
}

/**
 * What the CLI does in a project when the page doesn't choose (get_settings, effective settings):
 * { applied: { model, effort… } of a process without flags, defaults: { mode, effort,
 * modelEfforts: { <model ID>: level } } } — the dropdowns show these values as "(def)".
 */
function settingsDefaults(r) {
  const eff = r.effective || {};
  const modelEfforts = {};
  for (const [id, v] of Object.entries(eff.modelSettings || {})) if (typeof v?.effortLevel === 'string') modelEfforts[id] = v.effortLevel;
  return {
    applied: r.applied || {},
    defaults: {
      mode: typeof eff.permissions?.defaultMode === 'string' ? eff.permissions.defaultMode : 'default',
      effort: typeof eff.effortLevel === 'string' ? eff.effortLevel : null,
      modelEfforts,
    },
  };
}

/**
 * The folder to look up saved sessions for: like resolveDir, but a folder that is gone still
 * counts (a moved project's sessions are listed so it can be relinked). { dir, exists } or null.
 */
async function sessionsDir(p) {
  const dir = await resolveDir(p);
  if (dir) return { dir, exists: true };
  return typeof p === 'string' && path.isAbsolute(expandHome(p.trim())) ? { dir: path.resolve(expandHome(p.trim())), exists: false } : null;
}

/** Returns an absolute existing directory for `p` (default: WORK_DIR), or null. */
async function resolveDir(p) {
  const dir = typeof p === 'string' && p.trim() ? path.resolve(expandHome(p.trim())) : WORK_DIR;
  const ok = await fs.promises.stat(dir).then((s) => s.isDirectory(), () => false);
  return ok ? dir : null;
}

const TREE_MAX_ENTRIES = 2000;

/**
 * One level of the project's file tree (lazy: the UI asks for a folder when it is expanded).
 * `path` is relative to the project folder `cwd`; the real path must stay inside it, also
 * through symlinks, so the tree can't be used to browse the rest of the disk.
 */
/**
 * Resolves `?path=` (relative to the project `?cwd=`) to a real path that must stay inside the
 * project, also through symlinks. Returns { real, rel } or sends an error and returns null.
 */
async function resolveInProject(url, res) {
  const root = await resolveDir(url.searchParams.get('cwd'));
  if (!root) { sendJson(res, 404, { error: 'Project folder not found' }); return null; }
  const rel = path.normalize(url.searchParams.get('path') || '.');
  let realRoot, real;
  try {
    realRoot = await fs.promises.realpath(root);
    real = await fs.promises.realpath(path.resolve(root, rel));
  } catch {
    sendJson(res, 404, { error: 'Not found' });
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    sendJson(res, 403, { error: 'The path is outside the project folder' });
    return null;
  }
  return { real, rel };
}

const VIEW_MAX_BYTES = 2 * 1024 * 1024;  // `whole=1` (diffs): larger files are refused
const VIEW_CHUNK = 1024 * 1024;           // default piece of a file for the viewer
const VIEW_CHUNK_MAX = 16 * 1024 * 1024;  // a reload asks for everything shown so far, up to this
const EDIT_MAX_BYTES = 50 * 1024 * 1024;  // `edit=1` (the editor): whole file up to this, else 413

/**
 * Text of a project file for the viewer panel, in pieces: ?offset=&limit= (bytes). A piece ends
 * after its last "\n" (or at a UTF-8 character boundary for a line longer than the piece), so
 * pieces join without splitting characters. `next` is the offset of the next piece, null at the
 * end. With `whole=1` the file comes whole or not at all (413); `edit=1` is the same for the
 * editor, with a larger limit.
 */
async function handleFile(url, res) {
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  const edit = url.searchParams.get('edit') === '1';
  const whole = edit || url.searchParams.get('whole') === '1';
  if (whole && st.size > (edit ? EDIT_MAX_BYTES : VIEW_MAX_BYTES)) return sendJson(res, 413, { error: `The file is too large (${Math.round(st.size / 1024)} KB)` });
  const offset = Math.min(st.size, Math.max(0, Number(url.searchParams.get('offset')) || 0));
  const limit = whole ? st.size : Math.min(VIEW_CHUNK_MAX, Math.max(4096, Number(url.searchParams.get('limit')) || VIEW_CHUNK));
  const fh = await fs.promises.open(r.real, 'r');
  let buf;
  try {
    buf = Buffer.alloc(Math.min(limit, st.size - offset));
    buf = buf.subarray(0, (await fh.read(buf, 0, buf.length, offset)).bytesRead);
  } finally {
    await fh.close();
  }
  if (buf.includes(0)) return sendJson(res, 415, { error: 'A binary file — it can’t be viewed' });
  let end = buf.length;
  if (offset + end < st.size) {
    const nl = buf.lastIndexOf(10);
    if (nl >= 0) end = nl + 1;
    else {
      // No line end in the piece: drop an incomplete last character instead.
      let i = end - 1;
      while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
      const len = buf[i] >= 0xf0 ? 4 : buf[i] >= 0xe0 ? 3 : buf[i] >= 0xc0 ? 2 : 1;
      if (i + len > end) end = i;
    }
  }
  sendJson(res, 200, {
    path: r.rel.split(path.sep).join('/'), size: st.size, mtime: st.mtime.toISOString(),
    offset, next: offset + end < st.size ? offset + end : null, content: buf.toString('utf8', 0, end),
  });
}

/**
 * Saves a file from the editor: { cwd, path, content, mtime }. The file must exist inside the
 * project; if it changed on disk since `mtime` (Claude edited it meanwhile) the answer is 409 with
 * the current mtime, unless `force`. Written in place, so the mode and links are kept.
 */
async function handleFileSave(req, res) {
  let body;
  try { body = await readJsonBody(req, EDIT_MAX_BYTES * 2); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  if (typeof body.content !== 'string') return sendJson(res, 400, { error: 'content required' });
  const url = new URL('http://x/?' + new URLSearchParams({ cwd: body.cwd || '', path: body.path || '' }));
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  if (!body.force && body.mtime && st.mtime.toISOString() !== body.mtime) {
    return sendJson(res, 409, { error: 'The file changed on disk', mtime: st.mtime.toISOString() });
  }
  try {
    await fs.promises.writeFile(r.real, body.content, 'utf8');
  } catch (e) {
    return sendJson(res, e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500, { error: `${e.code || 'Error'}: ${e.message}` });
  }
  const after = await fs.promises.stat(r.real);
  sendJson(res, 200, { mtime: after.mtime.toISOString(), size: after.size });
}

const BYTES_MAX = 1024 * 1024; // one /api/bytes request reads at most this much

/**
 * Raw bytes of a project file for the hex view, any size: ?offset=&length= (≤ 1 MB). The body is
 * the bytes (application/octet-stream); X-File-Size and X-File-Mtime describe the whole file. With
 * `free=1`, X-Disk-Free gives the free space of its disk (inserting/deleting bytes rewrites the file
 * through a temporary copy, so it needs about the file's size free).
 */
async function handleBytes(url, res) {
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  const offset = Math.min(st.size, Math.max(0, Number(url.searchParams.get('offset')) || 0));
  const asked = url.searchParams.get('length');
  const length = Math.min(BYTES_MAX, st.size - offset, Math.max(0, asked == null ? 65536 : Number(asked) || 0));
  const buf = Buffer.alloc(length);
  const fh = await fs.promises.open(r.real, 'r');
  let n;
  try { n = (await fh.read(buf, 0, length, offset)).bytesRead; } finally { await fh.close(); }
  const free = url.searchParams.get('free') === '1' ? await diskFree(r.real) : null;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream', 'Content-Length': n, 'Cache-Control': 'no-store',
    'X-File-Size': String(st.size), 'X-File-Mtime': st.mtime.toISOString(),
    ...(free != null ? { 'X-Disk-Free': String(free) } : {}),
  });
  res.end(buf.subarray(0, n));
}

/** Free bytes (for an unprivileged user) on the disk holding `file`, or null if unknown. */
async function diskFree(file) {
  try {
    const s = await fs.promises.statfs(path.dirname(file));
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

const REWRITE_SLACK = 1024 * 1024; // free space kept beyond the new file's size

/**
 * Hex editing with inserted/deleted bytes: { cwd, path, mtime, size, pieces: [{ from, length } |
 * { data (base64) }] } describes the whole new file as ranges of the current one and new bytes.
 * It is written to a temporary file next to the original (same mode), then renamed over it, so a
 * failure midway leaves the original intact. The ranges refer to the file as it was at `mtime`, so
 * there is no `force`: if the file changed meanwhile the answer is 409. 507 when the disk lacks
 * room for the copy.
 */
async function handleBytesRewrite(req, res) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024 * 1024); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  if (!Array.isArray(body.pieces)) return sendJson(res, 400, { error: 'pieces required' });
  const url = new URL('http://x/?' + new URLSearchParams({ cwd: body.cwd || '', path: body.path || '' }));
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  if (st.mtime.toISOString() !== body.mtime || st.size !== body.size) {
    return sendJson(res, 409, { error: 'The file changed on disk', mtime: st.mtime.toISOString() });
  }
  const pieces = [];
  let total = 0;
  for (const p of body.pieces) {
    if (p && typeof p.data === 'string') {
      const data = Buffer.from(p.data, 'base64');
      pieces.push({ data });
      total += data.length;
    } else {
      const from = Number(p?.from), length = Number(p?.length);
      if (!Number.isInteger(from) || !Number.isInteger(length) || from < 0 || length < 0 || from + length > st.size) {
        return sendJson(res, 400, { error: 'The chunk is outside the file' });
      }
      pieces.push({ from, length });
      total += length;
    }
  }
  const free = await diskFree(r.real);
  if (free != null && free < total + REWRITE_SLACK) {
    return sendJson(res, 507, { error: `Not enough disk space: ${Math.ceil((total + REWRITE_SLACK) / 1048576)} MB needed, ${Math.floor(free / 1048576)} MB free` });
  }
  const tmp = path.join(path.dirname(r.real), `.${path.basename(r.real)}.${crypto.randomBytes(4).toString('hex')}.ninebits-tmp`);
  let src, out;
  try {
    src = await fs.promises.open(r.real, 'r');
    out = await fs.promises.open(tmp, 'wx', st.mode & 0o7777);
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0;
    for (const p of pieces) {
      if (p.data) { await out.write(p.data, 0, p.data.length, pos); pos += p.data.length; continue; }
      for (let done = 0; done < p.length;) {
        const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, p.length - done), p.from + done);
        if (!bytesRead) throw new Error('the file got shorter while being written');
        await out.write(buf, 0, bytesRead, pos);
        pos += bytesRead;
        done += bytesRead;
      }
    }
    await out.sync();
    await out.close(); out = null;
    await src.close(); src = null;
    await fs.promises.chmod(tmp, st.mode & 0o7777);
    await fs.promises.rename(tmp, r.real);
  } catch (e) {
    await out?.close().catch(() => {});
    await src?.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    return sendJson(res, e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'ENOSPC' ? 507 : 500, { error: `${e.code || 'Error'}: ${e.message}` });
  }
  const after = await fs.promises.stat(r.real);
  sendJson(res, 200, { mtime: after.mtime.toISOString(), size: after.size });
}

/**
 * Hex editing: { cwd, path, mtime, patches: [{ offset, data (base64) }], force } overwrites bytes in
 * place — the file never grows or shrinks, so files of any size are patched without rewriting
 * them. 409 (with the current mtime) if the file changed since `mtime`, unless `force`.
 */
async function handleBytesSave(req, res) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024 * 1024); } catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }
  if (!Array.isArray(body.patches)) return sendJson(res, 400, { error: 'patches required' });
  const url = new URL('http://x/?' + new URLSearchParams({ cwd: body.cwd || '', path: body.path || '' }));
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile()) return sendJson(res, 404, { error: 'Not a file' });
  if (!body.force && body.mtime && st.mtime.toISOString() !== body.mtime) {
    return sendJson(res, 409, { error: 'The file changed on disk', mtime: st.mtime.toISOString() });
  }
  const patches = body.patches.map((p) => ({ offset: Number(p.offset), data: Buffer.from(String(p.data || ''), 'base64') }));
  if (patches.some((p) => !Number.isInteger(p.offset) || p.offset < 0 || p.offset + p.data.length > st.size)) {
    return sendJson(res, 400, { error: 'The edit is outside the file' });
  }
  try {
    const fh = await fs.promises.open(r.real, 'r+');
    try { for (const p of patches) await fh.write(p.data, 0, p.data.length, p.offset); } finally { await fh.close(); }
  } catch (e) {
    return sendJson(res, e.code === 'EACCES' || e.code === 'EPERM' ? 403 : 500, { error: `${e.code || 'Error'}: ${e.message}` });
  }
  const after = await fs.promises.stat(r.real);
  sendJson(res, 200, { mtime: after.mtime.toISOString(), size: after.size });
}

const RAW_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif' };
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.weba': 'audio/webm' };
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska' };
// Video is streamed by ranges as it plays, so its size doesn't matter.
const RAW_MAX_BYTES = { image: 20 * 1024 * 1024, audio: 500 * 1024 * 1024, video: Infinity };

/** Images (Markdown files, image viewer), audio (audio player) and video (video player) of the project. */
async function handleRaw(url, res, range) {
  const r = await resolveInProject(url, res);
  if (!r) return;
  const ext = path.extname(r.real).toLowerCase();
  const type = RAW_TYPES[ext] || AUDIO_TYPES[ext] || VIDEO_TYPES[ext];
  if (!type) return sendJson(res, 415, { error: 'Images, audio and video only' });
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isFile() || st.size > RAW_MAX_BYTES[type.split('/')[0]]) return sendJson(res, 404, { error: 'Not found' });
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // SVG may carry scripts: never let it run as a document of this origin.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  };
  // Byte ranges: the audio and video players ask for them to seek (and Safari to play at all).
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || '');
  if (m && (m[1] || m[2]) && st.size) {
    let start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    if (start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(r.real, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  fs.createReadStream(r.real).pipe(res);
}

async function handleTree(url, res) {
  const r = await resolveInProject(url, res);
  if (!r) return;
  const rel = r.rel;
  const realDir = r.real;
  let dirents;
  try {
    dirents = await fs.promises.readdir(realDir, { withFileTypes: true });
  } catch (e) {
    return sendJson(res, 403, { error: `No access: ${e.code || e.message}` });
  }
  const showHidden = url.searchParams.get('hidden') === '1';
  const visible = dirents.filter((d) => showHidden || !d.name.startsWith('.'));
  const total = visible.length;
  const entries = await Promise.all(
    visible.slice(0, TREE_MAX_ENTRIES).map(async (d) => {
      const full = path.join(realDir, d.name);
      let type = d.isDirectory() ? 'dir' : 'file';
      let size = null;
      if (d.isSymbolicLink()) {
        // A link is shown as what it points to; expanding it is still checked against the root.
        const st = await fs.promises.stat(full).catch(() => null);
        type = st?.isDirectory() ? 'dir' : 'file';
        size = st && !st.isDirectory() ? st.size : null;
      } else if (type === 'file') {
        size = (await fs.promises.stat(full).catch(() => null))?.size ?? null;
      }
      return { name: d.name, type, size, link: d.isSymbolicLink() || undefined };
    }),
  );
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.type === 'dir' ? -1 : 1));
  sendJson(res, 200, { path: rel === '.' ? '' : rel.split(path.sep).join('/'), entries, total, truncated: total > entries.length });
}

/** Subdirectories of a folder, for the folder picker. */
async function handleFsList(url, res) {
  const dir = await resolveDir(url.searchParams.get('path') || os.homedir());
  if (!dir) return sendJson(res, 404, { error: 'Folder not found' });
  const showHidden = url.searchParams.get('hidden') === '1';
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return sendJson(res, 403, { error: `No access: ${e.code || e.message}` });
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && (showHidden || !e.name.startsWith('.')))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(dir);
  sendJson(res, 200, { path: dir, parent: parent === dir ? null : parent, dirs });
}

/** Processes started through the wrapper: GET lists them, POST kills one. */
/**
 * Details of a live registered process for the processes view: its folder and where its stdout
 * and stderr go (lsof), and when that is a file, the end of it. Another process's pipe or terminal
 * can't be read from outside (what we'd read, its reader would miss), so for those only the
 * destination is told. Only processes of the registry (pid + start time must match).
 */
const OUTPUT_TAIL_BYTES = 16 * 1024;

async function processDetail(pid, started) {
  const e = registry.list().find((x) => x.pid === pid && x.started === started);
  if (!e) return null;
  const out = await new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd,1,2', '-F', 'ftn'], { timeout: 3000 }, (err, stdout) => resolve(stdout || ''));
  });
  const fds = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const v = line.slice(1);
    if (line[0] === 'f') fds[v] = cur = {};
    else if (cur && line[0] === 't') cur.type = v;
    else if (cur && line[0] === 'n') cur.name = v;
  }
  const where = (fd) => {
    if (!fd) return { kind: 'closed' };
    if (fd.type === 'REG') return { kind: 'file', path: fd.name };
    if (fd.name === '/dev/null') return { kind: 'null' };
    if (fd.name === '(revoked)' || /^\/dev\/(tty|pts)/.test(fd.name || '')) return { kind: 'tty', path: fd.name };
    if (['PIPE', 'FIFO', 'unix'].includes(fd.type)) return { kind: 'pipe' };
    if (/^IPv[46]$/.test(fd.type || '')) return { kind: 'socket', path: fd.name };
    return { kind: 'other', path: fd.name, type: fd.type };
  };
  const stdout = where(fds['1']), stderr = where(fds['2']);
  const tail = async (path) => {
    const fh = await fs.promises.open(path, 'r');
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, OUTPUT_TAIL_BYTES);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      let text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1); // from a whole line
      return { path, size, text, truncated: len < size };
    } finally {
      await fh.close();
    }
  };
  const files = [...new Set([stdout, stderr].filter((x) => x.kind === 'file').map((x) => x.path))];
  const output = [];
  for (const f of files) output.push(await tail(f).catch((err) => ({ path: f, error: err.message })));
  return { cwd: fds.cwd?.name || null, stdout, stderr, output };
}

async function handleProcesses(req, res, url) {
  if (req.method === 'GET') {
    await registry.scan();
    let processes = registry.list({ includeExited: url.searchParams.get('all') === '1' });
    // ?cwd=: only what was started for this project (a tab sees its own project's processes).
    // A claude run carries its folder; everything else is attributed through its run.
    const cwd = url.searchParams.get('cwd');
    if (cwd) {
      const runCwd = new Map();
      for (const e of registry.list({ includeExited: true })) if (e.kind === 'claude' && e.runId) runCwd.set(e.runId, e.cwd);
      processes = processes.filter((e) => (e.kind === 'claude' ? e.cwd : runCwd.get(e.parentRun?.runId)) === cwd);
    }
    return sendJson(res, 200, { serverPid: process.pid, processes });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const pid = Number(body.pid);
  if (!Number.isInteger(pid) || pid <= 1) return sendJson(res, 400, { error: 'Bad pid' });
  const signal = body.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM';
  try {
    const killed = await registry.kill(pid, { signal, tree: body.tree !== false });
    sendJson(res, 200, { killed });
  } catch (e) {
    sendJson(res, 404, { error: e.message });
  }
}

/** Browser's answer to a permission prompt. */
async function handlePermissionAnswer(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const resolve = runs.get(body.runId)?.pending.get(body.id);
  if (!resolve) return sendJson(res, 404, { error: 'Prompt not found or already answered' });
  const updatedInput = body.updatedInput && typeof body.updatedInput === 'object' && !Array.isArray(body.updatedInput)
    ? body.updatedInput
    : undefined;
  resolve(body.allow
    ? { behavior: 'allow', updatedInput, updatedPermissions: Array.isArray(body.updatedPermissions) ? body.updatedPermissions : undefined }
    : { behavior: 'deny', message: typeof body.message === 'string' && body.message ? body.message.slice(0, 2000) : 'The user denied this action in the web UI.' });
  sendJson(res, 200, { ok: true });
}

function handleRequest(req, res) {
  route(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'Forbidden' });

  if (req.method === 'GET' && url.pathname === '/') {
    // The page learns before its first script runs whether to use the server's recognition.
    return fs.readFile(INDEX_HTML, 'utf8', (err, html) => {
      if (err) return sendJson(res, 500, { error: err.message });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
  }
  if (req.method === 'GET' && url.pathname === '/i18n.js') {
    // The page's UI language: its Russian dictionary and translation helpers.
    return fs.readFile(I18N_JS, (err, js) => {
      if (err) return sendJson(res, 500, { error: err.message });
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(js);
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    // For the desktop app: is Claude working right now (asked before quitting)?
    // Processes only waiting for the next message don't count as working.
    return sendJson(res, 200, { activeRuns: [...runs.values()].filter((r) => r.child.exitCode === null && !r.waiting).length });
  }
  if (req.method === 'GET' && url.pathname === '/api/info') {
    // models: the CLI's /model picker for the dropdown (cli-models.js; null while unknown).
    return sendJson(res, 200, {
      server: 'claude-wrapper', version: SERVER_VERSION, pid: process.pid,
      cwd: WORK_DIR, home: os.homedir(), tts: false, term: false,
      models: cliModels.list(), defaultModel: cliModels.defaultModel(),
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/fsop') {
    return handleFsOp(req, res, { resolveDir, readJsonBody, sendJson });
  }
  if (req.method === 'POST' && url.pathname === '/api/upload') {
    return handleUpload(req, res, url, { resolveDir, sendJson });
  }
  if (req.method === 'GET' && url.pathname === '/api/bytes') {
    return handleBytes(url, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/bytes/save') {
    return handleBytesSave(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/bytes/rewrite') {
    return handleBytesRewrite(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/file/save') {
    return handleFileSave(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/file') {
    return handleFile(url, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/raw') {
    return handleRaw(url, res, req.headers.range);
  }
  if (req.method === 'GET' && url.pathname === '/api/audiotags') {
    // Metadata tags of an audio file for the viewer (see audio-tags.js).
    const r = await resolveInProject(url, res);
    if (!r) return;
    return readAudioTags(r.real).then((d) => sendJson(res, 200, d), (e) => sendJson(res, 500, { error: e.message }));
  }
  if (req.method === 'GET' && url.pathname === '/api/audiocover') {
    // The cover picture embedded in an audio file (type checked by its bytes, see audio-tags.js).
    const r = await resolveInProject(url, res);
    if (!r) return;
    const cover = await readAudioCover(r.real).catch(() => null);
    if (!cover) return sendJson(res, 404, { error: 'No cover' });
    res.writeHead(200, {
      'Content-Type': cover.type, 'Content-Length': cover.data.length,
      'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
    });
    return res.end(cover.data);
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    return handleSearch(url, res, { resolveInProject, sendJson });
  }
  if (req.method === 'GET' && url.pathname === '/api/tree') {
    return handleTree(url, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/fs') {
    return handleFsList(url, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return sendJson(res, 200, { projects: await sessions.listProjects() });
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions/count') {
    const d = await sessionsDir(url.searchParams.get('cwd'));
    if (!d) return sendJson(res, 404, { error: 'Folder not found' });
    return sendJson(res, 200, { cwd: d.dir, exists: d.exists, count: await sessions.countSessions(d.dir) });
  }
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    // `exists: false` with `projectDir`: the folder is gone, its history can follow it (relink).
    const d = await sessionsDir(url.searchParams.get('cwd'));
    if (!d) return sendJson(res, 404, { error: 'Folder not found' });
    const projectDir = d.exists ? undefined : (await sessions.projectDirsFor(d.dir))[0];
    return sendJson(res, 200, { cwd: d.dir, exists: d.exists, projectDir, sessions: await sessions.listSessions(d.dir) });
  }
  if (req.method === 'POST' && url.pathname === '/api/session/delete') {
    const body = await readJsonBody(req).catch(() => null);
    if (!body || !SESSION_ID_RE.test(body.sessionId || '')) return sendJson(res, 400, { error: 'Bad sessionId' });
    await releaseWaiting(body.sessionId);
    const busy = [...runs.values()].some((r) => r.sessionId === body.sessionId && r.child.exitCode === null);
    if (busy) return sendJson(res, 409, { error: 'Claude is working in this session now — wait for the answer to end' });
    try {
      return (await sessions.deleteSession(body.sessionId)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: 'Session not found' });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/project/relink') {
    // A project whose folder moved: its history goes to the new folder, so its sessions resume
    // from there (sessions.relinkProject). The CLI names history dirs after the real path.
    const body = await readJsonBody(req).catch(() => null);
    const dir = body && typeof body.cwd === 'string' && body.cwd.trim() ? await resolveDir(body.cwd) : null;
    if (!dir) return sendJson(res, 404, { error: 'Folder not found' });
    const real = await fs.promises.realpath(dir);
    const inProject = (r) => r.child.exitCode === null && sessions.encodeProjectDir(r.cwd) === body.dir;
    await Promise.all([...runs.values()].filter((r) => inProject(r) && r.waiting && r.sessionId).map((r) => releaseWaiting(r.sessionId)));
    if ([...runs.values()].some(inProject)) return sendJson(res, 409, { error: 'Claude is working in this project now — wait for the answer to end' });
    try {
      return sendJson(res, 200, { cwd: dir, ...(await sessions.relinkProject(body.dir, real)) });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/history') {
    // A page of it: `limit` items before `before` (the page shows the end first, then earlier pages).
    const num = (k) => (url.searchParams.has(k) ? Number.parseInt(url.searchParams.get(k), 10) : undefined);
    const history = await sessions.loadHistory(url.searchParams.get('id') || '', { before: num('before'), limit: num('limit') });
    return history ? sendJson(res, 200, history) : sendJson(res, 404, { error: 'Session not found' });
  }
  if (req.method === 'GET' && url.pathname === '/api/processes/detail') {
    const d = await processDetail(Number(url.searchParams.get('pid')), url.searchParams.get('started') || '');
    return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'The process is not among the ones the wrapper started' });
  }
  if (url.pathname === '/api/processes' && (req.method === 'GET' || req.method === 'POST')) {
    return handleProcesses(req, res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/usage') {
    return planUsage(url.searchParams.get('fresh') === '1').then((d) => sendJson(res, 200, d), (e) => sendJson(res, 502, { error: e.message }));
  }
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    // Subagents of every run (agent-tasks.js); `live`: its run can still stop it (stop_task).
    const list = agentTasks.list({ cwd: url.searchParams.get('cwd') || null, all: url.searchParams.get('all') === '1' });
    if (url.searchParams.get('spend') === '1') await Promise.all(list.map((a) => agentTasks.spendOf(a)));
    const alive = (a) => !a.ended && runs.get(a.runId)?.child.exitCode === null;
    // The runs they belong to: the root of each tree (the main agent), as in VS Code's agent map.
    const runInfo = {};
    for (const a of list) {
      const r = runs.get(a.runId);
      runInfo[a.runId] ??= { prompt: a.runPrompt, sessionId: r?.sessionId || a.sessionId, cwd: a.cwd, alive: !!r && r.child.exitCode === null, waiting: !!r?.waiting };
    }
    return sendJson(res, 200, { agents: list.map((a) => ({ ...a, live: alive(a) })), runs: runInfo });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/control') {
    return handleChatControl(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/session/control') {
    return handleSessionControl(req, res);
  }
  if (req.method === 'GET' && url.pathname === '/api/files') {
    const cwd = await resolveDir(url.searchParams.get('cwd'));
    if (!cwd) return sendJson(res, 404, { error: 'Folder not found' });
    return sendJson(res, 200, { files: await fileSearch.search(cwd, url.searchParams.get('q')) });
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    return handleChatSend(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/chat/finish') {
    return handleChatFinish(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    return handleChat(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/elicitation') {
    return handleElicitationAnswer(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/permission') {
    return handlePermissionAnswer(req, res);
  }
  sendJson(res, 404, { error: 'Not found' });
}

/** Starts the background work: the process registry's scans, the model list. */
function start() {
  registry.start();
  // One-shot claude processes (models, plan limits) run in an empty folder: no project hooks.
  fs.mkdirSync(path.join(RUN_DIR, 'api-sandbox'), { recursive: true });
  cliModels.refresh({ claudeBin: CLAUDE_BIN, cwd: path.join(RUN_DIR, 'api-sandbox'), env: cleanEnv() })
    .catch((e) => console.warn(`Model list: ${e.message} (using the CLI's cached catalog)`));
}

/** Ends what this process started for the chats (their pages are gone) and saves the registry. */
function stop() {
  for (const run of runs.values()) if (run.child.exitCode === null) run.child.kill('SIGTERM');
  runs.clear();
  try { registry.stop(); } catch {}
}

module.exports = { start, stop, handleRequest, activeRuns: () => [...runs.values()].filter((r) => r.child.exitCode === null && !r.waiting).length };

if (STANDALONE) {
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log(`Claude web wrapper: http://${HOST}:${PORT}`);
    console.log(`Working directory:  ${WORK_DIR}`);
    console.log(`Settings:           ${envFromFile.length ? `${envFromFile.length} from ${ENV_FILE}` : `defaults (${ENV_FILE} not found or empty)`}`);
    start();
  });

  // Same app over HTTPS when CLAUDE_WEB_HTTPS_PORT is set (certificate from mkcert, see .env).
  if (HTTPS_PORT) {
    let tls = null;
    try {
      tls = { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) };
    } catch (e) {
      console.warn(`HTTPS is off: cannot read the certificate (${e.code || e.message}).`);
      console.warn(`  Create one:  mkcert -cert-file ${TLS_CERT} -key-file ${TLS_KEY} localhost 127.0.0.1 ::1`);
    }
    if (tls) {
      https.createServer(tls, handleRequest)
        .on('error', (e) => console.warn(`HTTPS listener on ${HTTPS_PORT} failed: ${e.message}`))
        .listen(HTTPS_PORT, HOST, () => console.log(`HTTPS:              https://localhost:${HTTPS_PORT}`));
    }
  }

  // Persist the registry on shutdown; child processes are intentionally left running
  // so that they can be found and inspected after a restart.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      try { registry.stop(); } catch {}
      process.exit(0);
    });
  }
}
