/**
 * Claude Wrapper — VS Code extension around the wrapper server in server/ (a copy of Claude-AI's).
 *
 * - Server: one per machine on 127.0.0.1:<claudeWrapper.port>, shared by all VS Code windows and
 *   left running when they close (chats in progress survive a window reload). On activation the
 *   extension attaches to it (/api/info must answer `server: 'claude-wrapper'`); a server of another
 *   version or of changed code (server/build-id.js) is restarted when no Claude run is working.
 *   It runs on VS Code's own Node (process.execPath with ELECTRON_RUN_AS_NODE=1), data in the extension's global storage
 *   (NINEBITS_DATA_DIR: .env, .run/, server.log).
 * - Activity bar "Claude Wrapper": webview views with rows of two or three lines (WebList): Projects
 *   (Claude Code's projects; a click opens the folder in VS Code; a folder that is gone asks where
 *   the project went and moves its history; buttons: a new window, move the history), History (sessions of this window's
 *   folder; a click opens one in the chat, the cross moves it to the Trash), Processes and
 *   Subagents (a click opens the details in an editor preview, Preview; the cross stops it; title-bar
 *   toggles for finished entries and for all projects, `filters`) — polled every few seconds while
 *   visible.
 * - Secondary side bar: the chat, the server's page in an iframe (`?embed=vscode&cwd=<folder>`) inside
 *   a webview. The page and the extension talk through the webview's script by postMessage:
 *   page -> extension { source: 'claude-wrapper', type: 'ready' | 'state' | 'openFile' | 'showView' },
 *   extension -> page { target: 'claude-wrapper', type: 'setProject' | 'loadSession' | 'newChat' | 'stop' | 'finish' };
 *   the page's state carries `busy`, and opening another folder while Claude works asks first
 *   (whenChatMayLeave).
 * - Language: English by default, Russian when VS Code's display language is Russian. The manifest
 *   strings come from package.nls*.json, this file's from l10n/bundle.l10n.*.json (vscode.l10n.t),
 *   and the page gets `lang=<vscode.env.language>` in its URL (its own dictionary: public/i18n.js).
 */
'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const VERSION = require('./package.json').version;
const { buildId } = require('./server/build-id');
const SERVER_JS = path.join(__dirname, 'server', 'server.js');
const ENV_TEMPLATE = path.join(__dirname, 'config', 'env.example');
const POLL_MS = 3000;

const t = vscode.l10n.t;
/** 'ru' or 'en': the UI language, VS Code's display language when we have it, English otherwise. */
const LANG = /^ru\b/i.test(vscode.env.language) ? 'ru' : 'en';
const LOCALE = LANG === 'ru' ? 'ru-RU' : 'en-US';

let ctx;
let dataDir;
let serverReady = null; // Promise of the running server
let chat = null;        // ChatView

const port = () => vscode.workspace.getConfiguration('claudeWrapper').get('port') || 3210;
const base = () => `http://127.0.0.1:${port()}`;
/** This window's project: its first workspace folder. */
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;

// ---------------------------------------------------------------------------------------------
// HTTP to the server

function request(method, pathname, body, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(base() + pathname, {
      method,
      timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode >= 400) reject(Object.assign(new Error(json?.error || `HTTP ${res.statusCode}`), { status: res.statusCode }));
        else resolve(json);
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
const getJson = (p) => request('GET', p);
const postJson = (p, body) => request('POST', p, body);

// ---------------------------------------------------------------------------------------------
// Server

async function serverInfo() {
  try { return await request('GET', '/api/info', null, 1500); } catch { return null; }
}

/** Pid listening on our port (to stop a server we did not start in this window). */
function listenerPid() {
  return new Promise((resolve) => {
    execFile('lsof', ['-ti', `tcp:${port()}`, '-sTCP:LISTEN'], (err, out) => resolve(Number(String(out || '').trim().split('\n')[0]) || null));
  });
}

function startServer() {
  fs.mkdirSync(dataDir, { recursive: true });
  const envFile = path.join(dataDir, '.env');
  if (!fs.existsSync(envFile) && fs.existsSync(ENV_TEMPLATE)) fs.copyFileSync(ENV_TEMPLATE, envFile);
  // The extension host's own variables stay out of the server and so out of claude runs.
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(VSCODE_|ELECTRON_|CLAUDECODE|CLAUDE_CODE_|CLAUDE_WEB_|NINEBITS_|APPLICATION_INSIGHTS)/.test(k)) env[k] = v;
  }
  Object.assign(env, { ELECTRON_RUN_AS_NODE: '1', NINEBITS_DATA_DIR: dataDir, PORT: String(port()), CLAUDE_CWD: os.homedir() });
  const logFile = path.join(dataDir, 'server.log');
  try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.1'); } catch {}
  const out = fs.openSync(logFile, 'a');
  fs.writeSync(out, `\n=== ${new Date().toISOString()} starting server ${VERSION} on :${port()} ===\n`);
  const child = spawn(process.execPath, [SERVER_JS], { env, cwd: os.homedir(), detached: true, stdio: ['ignore', out, out] });
  child.unref();
  fs.closeSync(out);
}

async function waitFor(check, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function stopServer(pid) {
  pid = pid || (await listenerPid());
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  await waitFor(async () => !(await serverInfo()), 5000);
}

/**
 * Attaches to the running server, or starts one; a server of another version or of changed code
 * (server/build-id.js) is replaced when idle.
 */
async function ensureServer({ restart = false } = {}) {
  let info = await serverInfo();
  if (info && info.server !== 'claude-wrapper') {
    throw new Error(t('Port {0} is taken by another server (not Claude Wrapper). Set another one in the claudeWrapper.port setting.', port()));
  }
  if (info && (restart || info.version !== VERSION || info.build !== buildId())) {
    const status = await getJson('/api/status').catch(() => ({ activeRuns: 0 }));
    if (restart || !status.activeRuns) {
      await stopServer(info.pid);
      info = null;
    }
  }
  if (!info) {
    startServer();
    if (!(await waitFor(serverInfo, 15000))) throw new Error(t('The server did not start — see “Claude Wrapper: Server Log”'));
  }
}

function serverPromise(opts) {
  serverReady = ensureServer(opts);
  serverReady.catch((e) => vscode.window.showErrorMessage(`Claude Wrapper: ${e.message}`));
  return serverReady;
}

// ---------------------------------------------------------------------------------------------
// Formatting

const fmtDate = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
};
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const fmtTok = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');
const fmtKb = (kb) => (kb < 1024 ? t('{0} KB', kb) : kb < 1024 * 1024 ? t('{0} MB', Math.round(kb / 1024)) : t('{0} GB', (kb / 1024 / 1024).toFixed(1)));
const shortPath = (p) => (p && p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p);
const baseName = (p) => (p || '').split('/').filter(Boolean).pop() || '/';
const encodeProjectDir = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');

// ---------------------------------------------------------------------------------------------
// Tree views: each loads its data with load(), keeps the last answer and fires a change only when
// it differs (so expansion and selection survive the polling).

// ---------------------------------------------------------------------------------------------
// Projects, History, Processes, Subagents: webview views (a tree item has one line; a row gets two
// or three here). Rows are rendered on this side (escaped HTML) and replace the list when they change; the
// view's script only folds children (kept in the webview's state) and sends clicks on elements
// with data-act ("open" on a row's title, a cross for delete/stop) with the row's data-key.

const LIST_CSS = `
  body { margin: 0; padding: 2px 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  .empty { padding: 4px 20px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; align-items: flex-start; gap: 4px; padding: 3px 8px 3px calc(8px + var(--depth) * 14px); cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:hover .x { visibility: visible; }
  .row.current { background: var(--vscode-list-inactiveSelectionBackground); }
  .fold { width: 14px; flex: none; text-align: center; color: var(--vscode-icon-foreground); cursor: pointer; user-select: none; line-height: 18px; }
  .fold.none { visibility: hidden; }
  .main { flex: 1; min-width: 0; }
  .title { display: flex; gap: 6px; line-height: 18px; cursor: pointer; }
  .title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover .name { text-decoration: underline; }
  .ico { flex: none; width: 14px; text-align: center; }
  .accent .ico { color: var(--vscode-charts-orange, #d97757); }
  .warn .ico, .warn .state { color: var(--vscode-editorWarning-foreground, #cca700); }
  .bad .ico { color: var(--vscode-errorForeground); }
  .dim { opacity: .6; }
  .line { color: var(--vscode-descriptionForeground); font-size: .92em; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { visibility: hidden; flex: none; border: 0; background: none; color: var(--vscode-icon-foreground); cursor: pointer;
    font-size: 14px; line-height: 18px; width: 20px; padding: 0; border-radius: 3px; }
  .x:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-errorForeground); }
  .node.folded > .kids { display: none; }
`;

const LIST_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const list = document.getElementById('list');
  const state = vscode.getState() || { folded: [] };
  const folded = new Set(state.folded);
  const applyFolds = () => {
    for (const n of list.querySelectorAll('.node')) {
      const f = folded.has(n.dataset.key);
      n.classList.toggle('folded', f);
      const b = n.querySelector(':scope > .row .fold');
      if (b && !b.classList.contains('none')) b.textContent = f ? '▸' : '▾';
    }
  };
  window.addEventListener('message', (e) => {
    if (e.data?.type === 'list') { list.innerHTML = e.data.html; applyFolds(); }
  });
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const key = el.closest('.node')?.dataset.key;
    if (el.dataset.act === 'fold') {
      if (folded.has(key)) folded.delete(key); else folded.add(key);
      vscode.setState({ folded: [...folded] });
      applyFolds();
    } else {
      vscode.postMessage({ type: el.dataset.act, key });
    }
  });
  vscode.postMessage({ type: 'ready' });
`;

/** A webview document with a nonce CSP for its inline script. */
function webviewDoc(css, body, script) {
  const nonce = crypto.randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html lang="${LANG}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${css}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}

/**
 * One row of a list: a node with the row and its children.
 * @param {object} o { key, depth, title, tooltip, icon, cls, lines: [text], lineCls, acts: [{ act, title, label }],
 *   x: { act, title } (a cross, last), kids: [html] }
 */
function rowHtml(o) {
  const kids = o.kids || [];
  const lines = (o.lines || []).filter(Boolean).map((l, i) => `<div class="line${i === o.lines.filter(Boolean).length - 1 && o.lineCls ? ' ' + o.lineCls : ''}">${escapeHtml(l)}</div>`).join('');
  return `<div class="node" data-key="${escapeHtml(o.key)}"><div class="row ${o.cls || ''}" style="--depth:${o.depth || 0}">` +
    `<span class="fold${kids.length ? '' : ' none'}" data-act="fold">▾</span>` +
    `<div class="main"><div class="title" data-act="open" title="${escapeHtml(o.tooltip || '')}"><span class="ico">${o.icon || ''}</span>` +
    `<span class="name">${escapeHtml(String(o.title).slice(0, 300))}</span></div>${lines}</div>` +
    (o.acts || []).map((a) => `<button class="x" data-act="${a.act}" title="${escapeHtml(a.title)}">${a.label}</button>`).join('') +
    (o.x ? `<button class="x" data-act="${o.x.act}" title="${escapeHtml(o.x.title)}">✕</button>` : '') +
    `</div><div class="kids">${kids.join('')}</div></div>`;
}
const emptyHtml = (text) => `<div class="empty">${escapeHtml(text)}</div>`;

/** Base of the list views: load() -> data, render(data) -> HTML, act(type, key) for clicks. */
class WebList {
  constructor(id) {
    this.id = id;
    this.view = null;
    this.html = null;
    this.data = null;
  }
  resolveWebviewView(view) {
    this.view = view;
    this.html = null;
    view.webview.options = { enableScripts: true };
    view.webview.html = webviewDoc(LIST_CSS, '<div id="list"></div>', LIST_SCRIPT);
    view.webview.onDidReceiveMessage((m) => (m?.type === 'ready' ? this.refresh(true) : this.act(m?.type, m?.key)));
    view.onDidChangeVisibility(() => view.visible && this.refresh(true));
    view.onDidDispose(() => { this.view = null; });
  }
  async refresh(force = false) {
    if (!this.view) return;
    let html;
    try {
      await serverReady;
      this.data = await this.load();
      html = this.render(this.data);
    } catch (e) {
      html = emptyHtml(t('Error: {0}', e.message));
    }
    if (force || html !== this.html) {
      this.html = html;
      this.view?.webview.postMessage({ type: 'list', html });
    }
    preview?.sync(this);
  }
}

// --- Projects: Claude Code's projects; a click opens the folder in VS Code ---

class ProjectsView extends WebList {
  constructor() { super('claudeWrapper.projects'); }
  async load() {
    const { projects } = await getJson('/api/projects');
    const here = folder();
    const isHere = (p) => here && (p.cwd === here || p.dir === encodeProjectDir(here));
    // A project is a folder: this window's folder is listed even before its first session.
    return here && !projects.some(isHere) ? [{ cwd: here, exists: true, sessions: 0 }, ...projects] : projects;
  }
  render(projects) {
    if (!projects.length) return emptyHtml(t('No projects yet'));
    const here = folder();
    return projects.map((p) => {
      const current = here && (p.cwd === here || p.dir === encodeProjectDir(here));
      return rowHtml({
        key: p.dir || p.cwd, title: baseName(p.cwd),
        tooltip: p.exists ? p.cwd : t('Folder not found — click to point to where the project is now'),
        icon: !p.exists ? '⚠' : current ? '●' : '○', cls: [current ? 'current accent' : '', p.exists ? '' : 'warn'].join(' '),
        lines: [
          (p.sessions ? t('{0} sess. · {1}', p.sessions, fmtDate(p.updated)) : t('no sessions')) + (p.exists ? '' : ' · ' + t('folder not found')),
          shortPath(p.cwd),
        ],
        lineCls: p.exists ? '' : 'state',
        acts: [
          p.exists && !current ? { act: 'window', title: t('Open in New Window'), label: '⧉' } : null,
          p.dir ? { act: 'relink', title: t('Move History to Another Folder…'), label: '⇢' } : null,
        ].filter(Boolean),
      });
    }).join('');
  }
  act(type, key) {
    const p = this.data?.find((x) => (x.dir || x.cwd) === key);
    if (!p) return;
    if (type === 'open') openProject(p);
    else if (type === 'window') vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.cwd), { forceNewWindow: true });
    else if (type === 'relink') relinkProject(p);
  }
}

// --- History: the sessions of this window's folder; a click opens one in the chat ---

class HistoryView extends WebList {
  constructor() { super('claudeWrapper.history'); }
  async load() {
    const cwd = folder();
    if (!cwd) return null;
    return (await getJson('/api/sessions?cwd=' + encodeURIComponent(cwd))).sessions;
  }
  render(sessions) {
    if (!sessions) return emptyHtml(t('Open a project folder'));
    if (!sessions.length) return emptyHtml(t('No sessions in this folder yet'));
    return sessions.map((s) => {
      const current = chat?.state.sessionId === s.id;
      return rowHtml({
        key: s.id, title: s.title || t('untitled'), tooltip: `${s.title || ''}\n${t('session {0}', s.id)}`,
        icon: current ? '●' : '○', cls: current ? 'current accent' : '',
        lines: [t('{0} · {1} msg.', fmtDate(s.updated), s.messages), s.lastPrompt && s.lastPrompt !== s.title ? s.lastPrompt.replace(/\s+/g, ' ') : ''],
        x: { act: 'delete', title: t('Move Session to Trash') },
      });
    }).join('');
  }
  act(type, key) {
    const s = this.data?.find((x) => x.id === key);
    if (!s) return;
    if (type === 'open') vscode.commands.executeCommand('claudeWrapper.openSession', s);
    else if (type === 'delete') deleteSession(s);
  }
}

async function deleteSession(s) {
  const yes = t('Delete');
  if ((await vscode.window.showWarningMessage(t('Move session “{0}” to the Trash?', s.title), { modal: true }, yes)) !== yes) return;
  try {
    await postJson('/api/session/delete', { sessionId: s.id });
    if (chat.state.sessionId === s.id) chat.post({ type: 'newChat' });
    historyView.refresh(true);
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not delete: {0}', e.message));
  }
}

// --- Processes: every Claude Code process and what it started; a click shows the details ---

const procKey = (p) => `${p.pid}@${p.started}`;
/** A process's title: a Claude Code process by its session's name, anything else by its command. */
function procTitle(p) {
  if (p.kind === 'claude' && p.name) return `claude · ${p.name}`;
  const words = p.command.split(/\s+/);
  return `${baseName(words[0])} ${words.slice(1).join(' ')}`.trim();
}
/** Left behind: its parent is gone (reparented to launchd) and it still runs. */
const isOrphan = (p) => !p.exited && p.ppid === 1 && p.kind !== 'claude';
const fmtWhen = (iso) => new Date(iso).toLocaleString(LOCALE, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

class ProcessesView extends WebList {
  constructor() { super('claudeWrapper.processes'); }
  async load() {
    const cwd = folder();
    const q = new URLSearchParams();
    if (filters.get('procFinished')) q.set('all', '1');
    if (cwd && !filters.get('procAllProjects')) q.set('cwd', cwd);
    const { processes } = await getJson('/api/processes?' + q);
    return processes.filter((p) => p.kind !== 'server' && p.kind !== 'bridge');
  }
  render(list) {
    if (!list.length) return emptyHtml(filters.get('procFinished') ? t('Claude has started no processes lately') : t('Claude has no processes running now'));
    // Each process under its parent (by ppid) when the parent is listed too (live ones first: a
    // pid may have been reused).
    const byPid = new Map();
    for (const p of [...list].sort((a, b) => Number(!a.exited) - Number(!b.exited))) byPid.set(p.pid, p);
    const kids = new Map(list.map((p) => [p, []]));
    const roots = [];
    for (const p of list) {
      const parent = p.ppid !== p.pid && byPid.get(p.ppid);
      (parent && parent !== p ? kids.get(parent) : roots).push(p);
    }
    const allProjects = filters.get('procAllProjects');
    const node = (p, depth) => {
      const orphan = isOrphan(p);
      return rowHtml({
        key: procKey(p), depth, title: procTitle(p), tooltip: p.command,
        icon: p.exited ? '⊘' : orphan ? '⚠' : p.kind === 'claude' ? '✻' : '›',
        cls: [p.kind === 'claude' ? 'accent' : '', orphan ? 'warn' : '', p.exited ? 'dim' : ''].join(' '),
        lines: [
          [`PID ${p.pid}`, p.exited ? t('finished {0}', fmtWhen(p.exited)) : fmtWhen(p.started),
            !p.exited && p.cpu != null ? `${p.cpu}%` : '', !p.exited && p.rss != null ? fmtKb(p.rss) : ''].filter(Boolean).join(' · '),
          p.kind === 'claude'
            ? [p.cwd && (allProjects || p.cwd !== folder()) ? shortPath(p.cwd) : '', p.sessionId ? t('session {0}', p.sessionId.slice(0, 8)) : ''].filter(Boolean).join(' · ')
            : orphan ? t('no parent') : '',
        ],
        lineCls: orphan ? 'state' : '',
        x: p.exited ? null : { act: 'stop', title: t('Stop the process and its children') },
        kids: kids.get(p).map((c) => node(c, depth + 1)),
      });
    };
    return roots.map((p) => node(p, 0)).join('');
  }
  act(type, key) {
    const p = this.data?.find((x) => procKey(x) === key);
    if (!p) return;
    if (type === 'open') Preview.show(new ProcessSubject(p));
    else if (type === 'stop') stopProcess(p);
  }
}

/** Asks, then stops a process and its descendants (SIGTERM through the server). */
async function stopProcess(p) {
  const yes = t('Stop');
  if ((await vscode.window.showWarningMessage(t('Stop process {0} and its children?', p.pid) + '\n' + p.command.slice(0, 200), { modal: true }, yes)) !== yes) return;
  try {
    await postJson('/api/processes', { pid: p.pid, tree: true });
    setTimeout(() => processesView.refresh(true), 500);
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not stop: {0}', e.message));
  }
}

// --- Subagents: by run, nested; a click shows an agent's details ---

const AGENT_STATUS = { running: t('working'), pending: t('waiting'), paused: t('paused'), completed: t('done'), failed: t('failed'), killed: t('stopped'), stopped: t('stopped') };
const agentTitle = (a) => `${a.agent || 'agent'}${a.background ? ' ' + t('(background)') : ''}: ${a.description || t('no description')}`;
const agentDur = (a) => fmtDur(a.usage?.duration_ms != null && a.ended ? a.usage.duration_ms : (a.ended || Date.now()) - a.started);

class AgentsView extends WebList {
  constructor() { super('claudeWrapper.agents'); }
  async load() {
    const cwd = folder();
    const q = new URLSearchParams();
    if (filters.get('agentFinished')) q.set('all', '1');
    if (cwd && !filters.get('agentAllProjects')) q.set('cwd', cwd);
    const d = await getJson('/api/agents?' + q);
    return { agents: d.agents, runs: d.runs || {} };
  }
  render({ agents, runs }) {
    if (!agents.length) return emptyHtml(filters.get('agentFinished') ? t('No subagents in the last hour') : t('No subagent is working now'));
    const groups = new Map();
    for (const a of agents) {
      if (!groups.has(a.runId)) groups.set(a.runId, []);
      groups.get(a.runId).push(a);
    }
    const out = [];
    for (const [rid, list] of groups) {
      const info = runs[rid] || {};
      const ids = new Set(list.map((a) => a.id));
      const kids = new Map(list.map((a) => [a.id, []]));
      const top = [];
      for (const a of list.sort((x, y) => x.started - y.started)) (ids.has(a.parentId) ? kids.get(a.parentId) : top).push(a);
      const node = (a, depth) => {
        const u = a.usage || {};
        return rowHtml({
          key: 'a:' + a.id, depth, title: agentTitle(a), tooltip: a.prompt ? a.prompt.slice(0, 500) : '',
          icon: !a.ended ? '◌' : a.status === 'completed' ? '✓' : a.status === 'failed' ? '✗' : '⊘',
          cls: !a.ended ? 'accent' : a.status === 'failed' ? 'bad dim' : 'dim',
          lines: [
            [agentDur(a), a.model || '', u.total_tokens ? fmtTok(u.total_tokens) : '', u.tool_uses ? t('{0} actions', u.tool_uses) : '', AGENT_STATUS[a.status] || a.status].filter(Boolean).join(' · '),
            !a.ended ? (a.activity || a.lastTool || '') : '',
          ],
          x: a.live ? { act: 'stop', title: t('Stop Subagent') } : null,
          kids: kids.get(a.id).map((c) => node(c, depth + 1)),
        });
      };
      const working = list.filter((a) => !a.ended).length;
      out.push(rowHtml({
        key: 'r:' + rid, title: `“${info.prompt || t('run')}”`, tooltip: info.prompt || '', icon: '✻', cls: info.alive ? 'accent' : 'dim',
        lines: [
          [info.alive ? (info.waiting ? t('waiting for a message') : t('working')) : t('finished'), working ? t('agents: {0}, working {1}', list.length, working) : t('agents: {0}', list.length)].join(' · '),
          [info.cwd && (filters.get('agentAllProjects') || info.cwd !== folder()) ? shortPath(info.cwd) : '', info.sessionId ? t('session {0}', info.sessionId.slice(0, 8)) : ''].filter(Boolean).join(' · '),
        ],
        kids: top.map((a) => node(a, 1)),
      }));
    }
    return out.join('');
  }
  act(type, key) {
    if (key?.startsWith('r:')) {
      const info = this.data?.runs[key.slice(2)];
      if (type === 'open' && info?.sessionId) openSessionInChat(info.sessionId, info.prompt || '');
      return;
    }
    const a = this.data?.agents.find((x) => 'a:' + x.id === key);
    if (!a) return;
    if (type === 'open') Preview.show(new AgentSubject(a));
    else if (type === 'stop') stopAgent(a);
  }
}

async function stopAgent(a) {
  const yes = t('Stop');
  if ((await vscode.window.showWarningMessage(t('Stop the subagent “{0}”?', a.description || a.agent || a.id), { modal: true }, yes)) !== yes) return;
  try {
    await postJson('/api/chat/control', { runId: a.runId, request: { subtype: 'stop_task', task_id: a.id } });
    setTimeout(() => agentsView.refresh(true), 500);
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not stop: {0}', e.message));
  }
}

async function openSessionInChat(id, title) {
  await chat.reveal();
  chat.post({ type: 'loadSession', id, title });
}

// ---------------------------------------------------------------------------------------------
// Details in an editor tab, a preview like a single-clicked file: one panel, reused for the next
// subject (a process or a subagent); re-read every few seconds while it lives and the tab shows.
// A subject: key, title(), live(), refresh() (reads its details), sync(view) (takes its fresh entry
// from a list view's data), html(), act(type).

const DETAIL_CSS = `
  body { padding: 12px 20px; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  h2 { font-size: 1.3em; margin: 0 0 4px; font-weight: 600; word-break: break-word; }
  h3 { font-size: 1em; margin: 14px 0 4px; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
  .warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  table { border-collapse: collapse; margin-bottom: 14px; }
  td { padding: 3px 14px 3px 0; vertical-align: top; }
  td:first-child { color: var(--vscode-descriptionForeground); white-space: nowrap; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; white-space: pre-wrap; word-break: break-word;
    font: var(--vscode-editor-font-size) var(--vscode-editor-font-family); margin: 4px 0 14px; }
  pre.out { max-height: 50vh; overflow: auto; word-break: break-all; }
  ul { margin: 4px 0 14px; padding-left: 20px; }
  li { margin: 2px 0; word-break: break-word; }
  .note { color: var(--vscode-descriptionForeground); font-size: .92em; }
  .bar { display: flex; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }
  button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 4px 12px;
    border-radius: 2px; cursor: pointer; font: inherit; }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.danger:hover { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
`;

const DETAIL_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  window.addEventListener('message', (e) => {
    if (e.data?.type !== 'detail') return;
    const pre = root.querySelector('pre.out');
    const atEnd = !pre || pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
    const keep = e.data.key === root.dataset.key ? window.scrollY : 0;
    root.dataset.key = e.data.key;
    root.innerHTML = e.data.html;
    window.scrollTo(0, keep);
    const out = root.querySelector('pre.out');
    if (out && atEnd) out.scrollTop = out.scrollHeight;
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) vscode.postMessage({ type: b.dataset.act });
  });
  vscode.postMessage({ type: 'ready' });
`;

const OUTPUT_WHERE = {
  file: (o) => t('to the file {0}', shortPath(o.path)),
  pipe: () => t('to a pipe to the parent process — it can’t be read from outside'),
  tty: (o) => (o.path === '(revoked)' ? t('to a terminal that is already closed') : t('to the terminal {0}', o.path)),
  null: () => t('nowhere (/dev/null)'),
  socket: (o) => t('to the network connection {0}', o.path),
  closed: () => t('closed'),
  other: (o) => `${o.type || ''} ${o.path || ''}`.trim(),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
const esc = (s) => escapeHtml(s);
const table = (rows) => '<table>' + rows.filter(Boolean).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
const button = (act, label, cls = '') => `<button class="${cls}" data-act="${act}">${esc(label)}</button>`;

let preview = null; // the open Preview

class Preview {
  static show(subject) {
    if (!preview) preview = new Preview();
    preview.subject = subject;
    preview.panel.reveal(undefined, true);
    preview.render();
    preview.reload();
  }
  constructor() {
    this.subject = null;
    this.panel = vscode.window.createWebviewPanel('claudeWrapper.preview', '', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true });
    this.panel.iconPath = vscode.Uri.file(path.join(__dirname, 'resources', 'icon.png'));
    this.panel.webview.html = webviewDoc(DETAIL_CSS, '<div id="root"></div>', DETAIL_SCRIPT);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.timer = setInterval(() => this.panel.visible && this.subject?.live() && this.reload(), POLL_MS);
    this.panel.onDidDispose(() => { clearInterval(this.timer); preview = null; });
  }
  async reload() {
    const s = this.subject;
    if (!s || this.loading) return;
    this.loading = true;
    try { await s.refresh(); } finally { this.loading = false; }
    if (s === this.subject) this.render();
  }
  /** After a list view refreshed: the subject takes its fresh entry from it. */
  sync(view) {
    if (this.subject?.sync(view)) this.render();
  }
  render() {
    const s = this.subject;
    if (!s) return;
    this.panel.title = s.title();
    this.panel.webview.postMessage({ type: 'detail', key: s.key, html: s.html() });
  }
  onMessage(m) {
    if (m?.type === 'ready') return this.render();
    if (m?.type === 'refresh') return this.reload();
    this.subject?.act(m?.type);
  }
}

class ProcessSubject {
  constructor(p) { this.p = p; this.key = 'p:' + procKey(p); this.d = null; this.error = null; }
  title() { return `${t('Process')} ${this.p.pid}`; }
  live() { return !this.p.exited; }
  async refresh() {
    if (this.p.exited) return;
    try {
      this.d = await getJson(`/api/processes/detail?pid=${this.p.pid}&started=${encodeURIComponent(this.p.started)}`);
      this.error = null;
    } catch (e) {
      // 404: no longer among the live processes — it has exited.
      if (e.status === 404) this.p = { ...this.p, exited: new Date().toISOString() };
      else this.error = e.message;
    }
  }
  sync(view) {
    if (view !== processesView) return false;
    const fresh = view.data?.find((x) => procKey(x) === procKey(this.p));
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(this.p)) return false;
    this.p = fresh;
    return true;
  }
  html() {
    const p = this.p, d = this.d;
    const orphan = isOrphan(p);
    const where = (o) => (OUTPUT_WHERE[o.kind] || OUTPUT_WHERE.other)(o);
    const session = p.sessionId || p.parentRun?.sessionId;
    let h = `<h2>${esc(procTitle(p))}</h2><div class="sub${orphan ? ' warn' : ''}">${esc(p.kind === 'claude' ? 'Claude Code' : orphan ? t('no parent') : t('process'))}</div>`;
    h += '<div class="bar">' + (p.exited ? '' : button('stop', '✕ ' + t('Stop'), 'danger')) +
      (session ? button('session', t('Open the session in the chat')) : '') + button('refresh', t('Refresh')) + '</div>';
    h += table([
      [t('State'), p.exited ? t('finished {0}', new Date(p.exited).toLocaleString(LOCALE)) : orphan ? t('The parent has finished; the process still runs') : t('running')],
      [t('Started'), new Date(p.started).toLocaleString(LOCALE)],
      ['PID', `${p.pid} · PPID ${p.ppid}${p.pgid ? ' · PGID ' + p.pgid : ''}`],
      !p.exited && p.cpu != null ? [t('CPU'), `${p.cpu}%`] : null,
      !p.exited && p.rss != null ? [t('Memory'), fmtKb(p.rss)] : null,
      p.cwd || d?.cwd ? [t('Folder'), shortPath(d?.cwd || p.cwd)] : null,
      session ? [t('Session'), (p.name ? p.name + ' · ' : '') + session] : null,
      d ? [t('Output'), where(d.stdout)] : null,
      d ? [t('Errors'), d.stderr.kind === d.stdout.kind && d.stderr.path === d.stdout.path ? t('the same place') : where(d.stderr)] : null,
    ]);
    h += `<h3>${esc(t('Command'))}</h3><pre>${esc(p.command)}</pre>`;
    if (this.error) h += `<div class="warn">${esc(t('Error: {0}', this.error))}</div>`;
    for (const o of d?.output || []) {
      if (o.error) { h += `<div class="note">${esc(shortPath(o.path))}: ${esc(o.error)}</div>`; continue; }
      h += `<h3>${esc(shortPath(o.path))}</h3><div class="note">${esc(o.truncated ? t('End of the file: the last 16 KB of {0}', fmtKb(Math.round(o.size / 1024))) : t('The whole file ({0})', fmtKb(Math.ceil(o.size / 1024))))}</div>`;
      h += `<pre class="out">${esc(stripAnsi(o.text) || t('(empty)'))}</pre>`;
    }
    return h;
  }
  act(type) {
    const session = this.p.sessionId || this.p.parentRun?.sessionId;
    if (type === 'stop') stopProcess(this.p);
    else if (type === 'session' && session) openSessionInChat(session, this.p.name || '');
  }
}

class AgentSubject {
  constructor(a) { this.a = a; this.key = 'a:' + a.id; }
  title() { return `${t('Subagent')} ${this.a.agent || ''}`.trim(); }
  live() { return !this.a.ended; }
  async refresh() {
    // spend=1: what the agent used, from its transcript
    const d = await getJson('/api/agents?all=1&spend=1').catch(() => null);
    const fresh = d?.agents.find((x) => x.id === this.a.id);
    if (fresh) this.a = fresh;
  }
  sync(view) {
    if (view !== agentsView) return false;
    const fresh = view.data?.agents.find((x) => x.id === this.a.id);
    if (!fresh) return false;
    this.a = { ...fresh, spend: fresh.spend || this.a.spend };
    return true;
  }
  html() {
    const a = this.a, u = a.usage || {}, sp = a.spend;
    let h = `<h2>${esc(a.description || t('no description'))}</h2><div class="sub">${esc([a.agent || 'agent', a.background ? t('(background)') : '', a.runPrompt ? `“${a.runPrompt}”` : ''].filter(Boolean).join(' · '))}</div>`;
    h += '<div class="bar">' + (a.live ? button('stop', '✕ ' + t('Stop'), 'danger') : '') +
      (a.live && !a.background && a.toolUseId ? button('background', '⇣ ' + t('Send to the background')) : '') +
      (a.sessionId ? button('session', t('Open the session in the chat')) : '') + button('refresh', t('Refresh')) + '</div>';
    h += table([
      [t('State'), AGENT_STATUS[a.status] || a.status],
      [t('Started'), new Date(a.started).toLocaleString(LOCALE)],
      [a.ended ? t('How long it worked') : t('How long it has been working'), agentDur(a)],
      a.model ? [t('Model'), a.model] : null,
      u.total_tokens ? [t('Context + output'), fmtTok(u.total_tokens)] : null,
      u.tool_uses ? [t('Actions'), String(u.tool_uses)] : null,
      sp ? [t('Spent'), t('from cache {0} · to cache {1} · input {2} · output {3} · requests {4}', fmtTok(sp.cacheRead), fmtTok(sp.cacheWrite), fmtTok(sp.input), fmtTok(sp.output), sp.requests)] : null,
      a.cwd ? [t('Folder'), shortPath(a.cwd)] : null,
      a.sessionId ? [t('Session'), a.sessionId] : null,
    ]);
    if (a.activity && !a.ended) h += `<h3>${esc(t('Now'))}</h3><div>${esc(a.activity)}</div>`;
    if (a.prompt) h += `<h3>${esc(t('Task'))}</h3><pre>${esc(a.prompt)}</pre>`;
    if (a.steps?.length) {
      h += `<h3>${esc(a.messages > a.steps.length ? t('Last steps ({0} of {1} messages)', a.steps.length, a.messages) : t('Last steps ({0})', a.steps.length))}</h3>`;
      h += '<ul>' + a.steps.map((st) => `<li><b>${esc(st.name)}</b>${st.detail ? ': ' + esc(st.detail) : ''}</li>`).join('') + '</ul>';
    }
    if (a.result) h += `<h3>${esc(t('Result'))}</h3><pre>${esc(a.result)}</pre>`;
    if (a.error) h += `<h3 class="warn">${esc(t('Error'))}</h3><pre>${esc(a.error)}</pre>`;
    return h;
  }
  act(type) {
    const a = this.a;
    if (type === 'stop') stopAgent(a);
    else if (type === 'session' && a.sessionId) openSessionInChat(a.sessionId, a.runPrompt || '');
    else if (type === 'background') {
      postJson('/api/chat/control', { runId: a.runId, request: { subtype: 'background_tasks', tool_use_id: a.toolUseId } })
        .then(() => setTimeout(() => agentsView.refresh(true), 500), (e) => vscode.window.showErrorMessage(t('Could not send to the background: {0}', e.message)));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Chat: the server's page in an iframe inside a webview view (secondary side bar).

class ChatView {
  constructor() {
    this.view = null;
    this.ready = false;
    this.queue = [];
    this.state = { cwd: null, sessionId: null, title: '' };
    this.onState = () => {};
  }
  async resolveWebviewView(view) {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true };
    view.webview.html = page(`<p class="note">${escapeHtml(t('Starting the Claude Wrapper server…'))}</p>`, '');
    view.webview.onDidReceiveMessage((m) => this.fromPage(m));
    view.onDidDispose(() => { this.view = null; this.ready = false; });
    try {
      await serverReady;
    } catch (e) {
      view.webview.html = page(`<p class="note">${escapeHtml(t('The server did not start: {0}', e.message))}</p>`, '');
      return;
    }
    this.load();
  }
  load() {
    if (!this.view) return;
    this.ready = false;
    const q = new URLSearchParams({ embed: 'vscode', lang: LANG });
    if (folder()) q.set('cwd', folder());
    this.view.webview.html = page('', `${base()}/?${q}`);
  }
  /** To the page, or queued until it says it is ready. */
  post(msg) {
    if (this.view && this.ready) this.view.webview.postMessage({ target: 'claude-wrapper', ...msg });
    else this.queue.push(msg);
  }
  async reveal() {
    await vscode.commands.executeCommand('claudeWrapper.chat.focus');
  }
  async fromPage(m) {
    if (!m || m.source !== 'claude-wrapper') return;
    if (m.type === 'ready') {
      this.ready = true;
      for (const q of this.queue.splice(0)) this.post(q);
    } else if (m.type === 'state') {
      this.state = { cwd: m.cwd, sessionId: m.sessionId, title: m.title, busy: !!m.busy };
      this.onState();
    } else if (m.type === 'showView' && ['processes', 'agents', 'history'].includes(m.view)) {
      // From the counts under the chat's input: that view in the side bar, revealed and expanded.
      vscode.commands.executeCommand(`claudeWrapper.${m.view}.focus`);
    } else if (m.type === 'openFile' && typeof m.path === 'string') {
      const uri = vscode.Uri.file(m.path);
      const opts = {};
      if (m.line) {
        const pos = new vscode.Position(Math.max(0, m.line - 1), Math.max(0, (m.col || 1) - 1));
        opts.selection = new vscode.Range(pos, pos);
      }
      // vscode.open honours editor associations: Markdown, images and the like open in VS Code's viewers.
      vscode.commands.executeCommand('vscode.open', uri, opts).then(undefined, (e) => vscode.window.showErrorMessage(e.message));
    }
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** The webview's document: the page in a full-size iframe, and the message relay between the two. */
function page(note, src) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const origin = `http://127.0.0.1:${port()}`;
  return `<!DOCTYPE html>
<html lang="${LANG}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
  iframe { border: 0; width: 100%; height: 100%; display: block; }
  .note { padding: 12px 16px; opacity: .8; }
</style></head><body>
${note}${src ? `<iframe id="page" src="${escapeHtml(src)}" allow="clipboard-read; clipboard-write; microphone; autoplay"></iframe>` : ''}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('page');
  window.addEventListener('message', (e) => {
    if (frame && e.source === frame.contentWindow) {
      if (e.origin === ${JSON.stringify(origin)} && e.data && e.data.source === 'claude-wrapper') vscode.postMessage(e.data);
    } else if (frame && e.data && e.data.target === 'claude-wrapper') {
      frame.contentWindow.postMessage(e.data, ${JSON.stringify(origin)});
    }
  });
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Commands

async function openProject(p) {
  if (!p) return;
  if (!p.exists) return relinkProject(p);
  if (p.cwd === folder()) return chat.reveal();
  if (!(await whenChatMayLeave(t('Opening the project {0} in this window stops it.', baseName(p.cwd))))) return;
  await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.cwd), { forceNewWindow: false });
}

/**
 * Before the chat's folder goes away while Claude works in it: stop now, ask Claude to finish (a
 * wrap-up message; we wait, with a cancellable notification, until its turn is over) or cancel.
 * Resolves to true when the switch may go on.
 */
async function whenChatMayLeave(why) {
  if (!chat?.state.busy) return true;
  const stop = t('Stop now'), finish = t('Ask to finish');
  const choice = await vscode.window.showWarningMessage(t('Claude is working in the chat.'), { modal: true, detail: why + ' ' + t('Stop it now, or ask it to finish first (the switch happens when it is done)?') }, stop, finish);
  if (!choice) return false;
  chat.post({ type: choice === stop ? 'stop' : 'finish' });
  const idle = (token) => new Promise((resolve) => {
    const started = Date.now();
    const tick = () => (!chat.state.busy ? resolve(true) : token?.isCancellationRequested || (choice === stop && Date.now() - started > 10000) ? resolve(!token?.isCancellationRequested) : setTimeout(tick, 300));
    setTimeout(tick, 500);
  });
  if (choice === stop) return idle();
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Waiting for Claude to finish…'), cancellable: true }, (_, token) => idle(token));
}

/** A project moved: pick its folder, its history (sessions, prompt history, settings) goes there. */
async function relinkProject(p) {
  if (!p?.dir) return;
  const gone = !p.exists;
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
    title: gone ? t('The folder of project “{0}” is not found — where is it now?', baseName(p.cwd)) : t('Where to move the history of project “{0}”?', baseName(p.cwd)),
    openLabel: t('Move the history here'),
    defaultUri: vscode.Uri.file(path.dirname(p.cwd)),
  });
  if (!picked?.[0]) return;
  try {
    const r = await postJson('/api/project/relink', { dir: p.dir, cwd: picked[0].fsPath });
    const parts = [];
    if (r.sessions) parts.push(t('sessions: {0}', r.sessions));
    if (r.prompts) parts.push(t('input history entries: {0}', r.prompts));
    if (r.settings) parts.push(t('project settings'));
    const open = t('Open Folder');
    const choice = await vscode.window.showInformationMessage(parts.length ? t('History moved ({0})', parts.join(', ')) : t('There was nothing to move'), open);
    trees.forEach((tree) => tree.refresh());
    if (choice === open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.cwd), { forceNewWindow: false });
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not move the history: {0}', e.message));
  }
}

let trees = [];
let historyView = null, processesView = null, agentsView = null;

/**
 * Toggles of the Processes and Subagents views (their title bars), kept per workspace and mirrored
 * into context keys claudeWrapper.<name> for the toggled state of the buttons:
 * procFinished / agentFinished — finished ones too (subagents: of the last hour);
 * procAllProjects / agentAllProjects — every project, not only this window's folder (processes: on
 * by default).
 */
const filters = {
  names: ['procFinished', 'procAllProjects', 'agentFinished', 'agentAllProjects'],
  // Processes of every project by default: what runs on the machine matters, wherever it came from.
  defaults: { procAllProjects: true },
  get(name) { return !!ctx.workspaceState.get('filter.' + name, !!this.defaults[name]); },
  async set(name, value) {
    await ctx.workspaceState.update('filter.' + name, value);
    await vscode.commands.executeCommand('setContext', 'claudeWrapper.' + name, value);
  },
  init() { for (const n of this.names) vscode.commands.executeCommand('setContext', 'claudeWrapper.' + n, this.get(n)); },
};

function activate(context) {
  ctx = context;
  filters.init();
  dataDir = context.globalStorageUri.fsPath;
  serverPromise();

  chat = new ChatView();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeWrapper.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }));

  const projects = new ProjectsView();
  const history = historyView = new HistoryView();
  const processes = processesView = new ProcessesView();
  const agents = agentsView = new AgentsView();
  for (const v of [projects, history, processes, agents]) context.subscriptions.push(vscode.window.registerWebviewViewProvider(v.id, v));
  trees = [projects, history, processes, agents];
  chat.onState = () => history.refresh(true); // the open session gets its mark
  const timer = setInterval(() => { for (const tree of trees) if (tree.view?.visible) tree.refresh(); }, POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  serverReady.then(() => trees.forEach((tree) => tree.refresh()), () => trees.forEach((tree) => tree.refresh()));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (folder()) chat.post({ type: 'setProject', cwd: folder() });
    trees.forEach((tree) => tree.refresh(true));
  }));

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('claudeWrapper.refresh', () => trees.forEach((tree) => tree.refresh(true)));
  const toggle = (name, tree) => async () => { await filters.set(name, !filters.get(name)); tree.refresh(true); };
  for (const [name, tree] of [['procFinished', processes], ['procAllProjects', processes], ['agentFinished', agents], ['agentAllProjects', agents]]) {
    const id = 'claudeWrapper.toggle' + name[0].toUpperCase() + name.slice(1);
    cmd(id, toggle(name, tree));
    cmd(id + '.on', toggle(name, tree)); // the same toggle, shown while it is on
  }
  cmd('claudeWrapper.newChat', async () => { await chat.reveal(); chat.post({ type: 'newChat' }); });
  cmd('claudeWrapper.openProject', openProject);
  cmd('claudeWrapper.openProjectNewWindow', (p) => p?.cwd && vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.cwd), { forceNewWindow: true }));
  cmd('claudeWrapper.relinkProject', (p) => p?.dir && relinkProject(p));
  cmd('claudeWrapper.openSession', (s) => s?.id && openSessionInChat(s.id, s.title || ''));
  cmd('claudeWrapper.deleteSession', (session) => session?.id && deleteSession(session));
  cmd('claudeWrapper.stopProcess', (p) => p?.pid && stopProcess(p));
  cmd('claudeWrapper.stopAgent', (a) => a?.id && stopAgent(a));
  cmd('claudeWrapper.restartServer', async () => {
    const status = await getJson('/api/status').catch(() => ({ activeRuns: 0 }));
    if (status.activeRuns) {
      const yes = t('Restart');
      if ((await vscode.window.showWarningMessage(t('Claude is working now ({0}). A restart will interrupt the answers in all windows.', status.activeRuns), { modal: true }, yes)) !== yes) return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Claude Wrapper: restarting the server…') }, () => serverPromise({ restart: true }).catch(() => {}));
    chat.load();
    trees.forEach((tree) => tree.refresh(true));
  });
  cmd('claudeWrapper.showServerLog', () => vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(dataDir, 'server.log'))));
}

function deactivate() {
  // The server keeps running: other windows use it, and chats in progress survive a reload.
}

module.exports = { activate, deactivate };
