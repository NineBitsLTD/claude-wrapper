/**
 * Claude Wrapper — VS Code extension: a chat with Claude Code (the `claude` CLI) and its projects,
 * history, processes and subagents.
 *
 * - No separate server: the wrapper's code in server/ (a copy of Claude-AI's server) runs in this
 *   process — startServer() requires server/server.js and its routes are called directly through
 *   server/inproc.js (getJson/postJson here, the chat page's fetch through its shim). Its data (the
 *   process registry, the shell journal) is in the extension's global storage, shared by the windows;
 *   each window has its own chats' claude runs, which end with their page or the window.
 * - Activity bar "Projects": one webview view (Sidebar; a single view, so its title and the refresh
 *   button sit in the container's title bar). The projects are its main list (a click opens the
 *   folder in VS Code; a folder that is gone asks where the project went and moves its history;
 *   buttons: a new window, move the history); under it the collapsible sections History (sessions of
 *   this window's folder; a click opens one in the chat, the trash moves it to the Trash), Processes
 *   and Subagents (a click opens the details in an editor preview, Preview; the cross stops it; header
 *   toggles for finished entries and all projects, `filters`) and MCP Servers (McpView: those of the
 *   chat's running Claude process, managed there — sign in, reconnect, enable, disable; otherwise the
 *   last list seen, and a check). Rows have two or three lines; the open sections are polled every
 *   few seconds while the view is visible.
 * - Secondary side bar: the chat, server/public/index.html right in a webview (chatHtml): window.CW
 *   gives it { embed: 'vscode', cwd, lang }, public/vscode-shim.js its channel to this side and its
 *   fetch('/api/...') bridge (messages 'http' / 'httpAbort' / 'httpReset', answers streamed back).
 *   Other messages: page -> extension { source: 'claude-wrapper', type: 'ready' | 'state' |
 *   'mcp' | 'tts' | 'stt' | 'audioOut' | 'openFile' | 'showView' }, extension -> page { target:
 *   'claude-wrapper', type: 'setProject' | 'loadSession' | 'newChat' | 'stop' | 'finish' | 'tts' |
 *   'ttsInfo' | 'stt' | 'audioOut' | 'windowFocus' }. 'tts' is the chat's speech and 'stt' its
 *   microphone, both through the TTS / STT MD Aloud extension when it is installed (`aloud`);
 *   'audioOut' names the Mac's sound output (headphones or speakers, for listening while it speaks); the
 *   page's state carries `busy` (opening another folder while Claude works asks first,
 *   whenChatMayLeave) and `runId` (its live Claude process, whose MCP servers the side bar
 *   manages); 'mcp' is the servers a process reported at start.
 * - Language: English by default, Russian when VS Code's display language is Russian. The manifest
 *   strings come from package.nls*.json, this file's from l10n/bundle.l10n.*.json (vscode.l10n.t),
 *   and the page gets window.CW.lang (its own dictionary: public/i18n.js).
 */
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const POLL_MS = 3000;
const PUBLIC_DIR = path.join(__dirname, 'server', 'public');

const t = vscode.l10n.t;
/** 'ru' or 'en': the UI language, VS Code's display language when we have it, English otherwise. */
const LANG = /^ru\b/i.test(vscode.env.language) ? 'ru' : 'en';
const LOCALE = LANG === 'ru' ? 'ru-RU' : 'en-US';

let ctx;
let server = null;      // server/server.js, running in this process
let inproc = null;      // server/inproc.js
let chat = null;        // ChatView

/** This window's project: its first workspace folder. */
const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;

// ---------------------------------------------------------------------------------------------
// The server's code, in this process: its routes are called directly (server/inproc.js)

/**
 * Loads and starts the server's code. Its data (the process registry, the shell journal) lives in
 * the extension's global storage, shared by the windows; NINEBITS_DATA_DIR tells server/paths.js
 * (cleanEnv keeps it out of the claude processes).
 */
function startServer(context) {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  process.env.NINEBITS_DATA_DIR = context.globalStorageUri.fsPath;
  server = require('./server/server.js');
  inproc = require('./server/inproc.js');
  server.start();
}

const getJson = (p) => inproc.call(server.handleRequest, 'GET', p);
const postJson = (p, body) => inproc.call(server.handleRequest, 'POST', p, body);

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
// The side bar: one webview view, "Projects" (a single view, so VS Code puts its title and its refresh
// button in the container's title bar, like the Explorer's). The projects are its main list; History,
// Processes and Subagents are collapsible sections under it, with their buttons in their headers.
// Rows (two or three lines each; a tree item would have one) are rendered on this side as escaped
// HTML and replace a section's body when it changes; the view's script folds rows and sections (kept
// in the webview's state) and sends clicks: data-act on a row ("open" on its title, a cross for
// delete/stop) with the row's data-key and its section, data-hact on a header's buttons.

const LIST_CSS = `
  body { margin: 0; padding: 2px 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  .empty { padding: 4px 20px; color: var(--vscode-descriptionForeground); }
  .row { display: flex; align-items: flex-start; gap: 2px; padding: 3px 8px 3px calc(4px + var(--depth) * 16px); cursor: default; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:hover .x { visibility: visible; }
  .row.current { background: var(--vscode-list-inactiveSelectionBackground); }
  /* The twistie and the icons as in VS Code's trees: codicons in the icon colour. */
  .codicon { font-size: 16px; line-height: 18px; color: var(--vscode-icon-foreground); }
  .fold { width: 16px; height: 18px; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer; user-select: none; }
  .fold.none { visibility: hidden; }
  .main { flex: 1; min-width: 0; }
  .title { display: flex; gap: 6px; line-height: 18px; cursor: pointer; }
  .title .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title:hover .name { text-decoration: underline; }
  .ico { flex: none; width: 16px; display: flex; align-items: center; justify-content: center; }
  .warn .state { color: var(--vscode-editorWarning-foreground, #cca700); }
  /* The current entry (this window's project, the chat's session): its icon in orange. */
  .current .ico .codicon { color: var(--vscode-charts-orange, #d97757); }
  .dim { opacity: .6; }
  .line { color: var(--vscode-descriptionForeground); font-size: .92em; line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .x { visibility: hidden; flex: none; border: 0; background: none; cursor: pointer; width: 20px; height: 20px; padding: 0;
    border-radius: 5px; display: flex; align-items: center; justify-content: center; }
  .x:hover { background: var(--vscode-toolbar-hoverBackground); }
  .node.folded > .kids { display: none; }
  .note { display: flex; align-items: center; gap: 4px; padding: 2px 20px 4px; color: var(--vscode-descriptionForeground); font-size: .92em; }
  /* MCP servers: the status in the icon's colour, as the chat's gear menu had it. */
  .mcp-connected .ico .codicon { color: var(--vscode-testing-iconPassed, #73c991); }
  .mcp-failed .ico .codicon, .mcp-failed .state { color: var(--vscode-errorForeground, #f14c4c); }
  .mcp-needs-auth .ico .codicon { color: var(--vscode-editorWarning-foreground, #cca700); }
  /* Sections: the projects fill the top, each open section shares the rest; a body scrolls. */
  html, body { height: 100%; }
  body { padding: 0; overflow: hidden; }
  .layout { display: flex; flex-direction: column; height: 100%; }
  .sec { display: flex; flex-direction: column; min-height: 0; }
  .sec.main { flex: 2 1 0; min-height: 44px; }
  .sec.sub { flex: 0 0 auto; position: relative; border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent)); }
  /* The sash above an open section, as VS Code's between views: drag to share the height. */
  .sash { position: absolute; left: 0; right: 0; top: -3px; height: 5px; z-index: 2; cursor: ns-resize; }
  .sash::after { content: ''; position: absolute; left: 0; right: 0; top: 1px; height: 3px; background: transparent; transition: background .1s .3s; }
  .sash:hover::after, .sash.active::after { background: var(--vscode-sash-hoverBorder, var(--vscode-focusBorder)); }
  .sec.collapsed > .sash { display: none; }
  body.resizing { cursor: ns-resize; user-select: none; }
  .sec.sub:not(.collapsed) { flex: 1 1 0; min-height: 66px; }
  .body { flex: 1; min-height: 0; overflow: auto; padding: 2px 0; }
  .sec.collapsed .body { display: none; }
  header { display: flex; align-items: center; height: 22px; padding-right: 6px; cursor: pointer; user-select: none; flex: none;
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em;
    background: var(--vscode-sideBarSectionHeader-background); color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground)); }
  header .chev { width: 20px; display: flex; justify-content: center; }
  header .label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header .tools { display: flex; gap: 2px; }
  header .tools button { visibility: hidden; border: 0; background: none; cursor: pointer; width: 22px; height: 20px; padding: 0;
    border-radius: 5px; display: flex; align-items: center; justify-content: center; }
  header:hover .tools button, .sec:focus-within header .tools button, header .tools button.on { visibility: visible; }
  header .tools button:hover { background: var(--vscode-toolbar-hoverBackground); }
  header .tools button.on { background: var(--vscode-inputOption-activeBackground, var(--vscode-toolbar-activeBackground)); }
`;

const LIST_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { folded: [] };
  // Heights of the open parts (px, by section) as last set with a sash; rescaled to the view.
  const sizes = state.sizes || {};
  const folded = new Set(state.folded);
  const save = () => vscode.setState({ folded: [...folded], sizes });
  const MIN = { main: 44, sub: 66 };
  const openParts = () => [...document.querySelectorAll('.sec')].filter((p) => !p.classList.contains('collapsed'));
  /**
   * The open parts share the view's height: by the saved sizes (missing ones by weight, the
   * projects twice a section), scaled to what the collapsed sections leave.
   */
  const layout = () => {
    const box = document.querySelector('.layout');
    if (!box) return;
    const all = [...document.querySelectorAll('.sec')];
    for (const p of all) if (p.classList.contains('collapsed')) p.style.flex = '0 0 auto';
    const open = openParts();
    const rest = all.filter((p) => !open.includes(p)).reduce((sum, p) => sum + p.offsetHeight, 0);
    const avail = Math.max(0, box.clientHeight - rest);
    const weight = (p) => (p.classList.contains('main') ? 2 : 1);
    const unit = avail / open.reduce((sum, p) => sum + weight(p), 0);
    const want = open.map((p) => sizes[p.dataset.sec] || weight(p) * unit);
    const scale = avail / (want.reduce((a, b) => a + b, 0) || 1);
    open.forEach((p, i) => { p.style.flex = '0 0 ' + Math.max(p.classList.contains('main') ? MIN.main : MIN.sub, want[i] * scale) + 'px'; });
  };
  new ResizeObserver(layout).observe(document.body);
  document.addEventListener('pointerdown', (e) => {
    const sash = e.target.closest('.sash');
    if (!sash) return;
    e.preventDefault();
    const below = sash.closest('.sec');
    const open = openParts();
    const above = open[open.indexOf(below) - 1];
    if (!above) return;
    for (const p of open) sizes[p.dataset.sec] = p.offsetHeight;
    const y0 = e.clientY, hA = above.offsetHeight, hB = below.offsetHeight;
    const minA = above.classList.contains('main') ? MIN.main : MIN.sub;
    sash.classList.add('active');
    document.body.classList.add('resizing');
    try { sash.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const d = Math.max(minA - hA, Math.min(hB - MIN.sub, ev.clientY - y0));
      sizes[above.dataset.sec] = hA + d;
      sizes[below.dataset.sec] = hB - d;
      layout();
    };
    const up = () => {
      sash.classList.remove('active');
      document.body.classList.remove('resizing');
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      save();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
  });
  // Double-click on a sash: back to the default shares.
  document.addEventListener('dblclick', (e) => {
    if (!e.target.closest('.sash')) return;
    for (const k of Object.keys(sizes)) delete sizes[k];
    save();
    layout();
  });
  const keyOf = (node) => node.closest('.sec').dataset.sec + ':' + node.dataset.key;
  const applyFolds = (root) => {
    for (const n of root.querySelectorAll('.node')) {
      const f = folded.has(keyOf(n));
      n.classList.toggle('folded', f);
      const b = n.querySelector(':scope > .row .fold');
      if (b && !b.classList.contains('none')) b.firstChild.className = 'codicon codicon-chevron-' + (f ? 'right' : 'down');
    }
  };
  const secEl = (name) => document.querySelector('.sec[data-sec="' + name + '"]');
  const setCollapsed = (name, c, tell) => {
    const el = secEl(name);
    if (!el || !el.classList.contains('sub')) return;
    el.classList.toggle('collapsed', c);
    el.querySelector('header .chev').firstChild.className = 'codicon codicon-chevron-' + (c ? 'right' : 'down');
    layout();
    if (tell) vscode.postMessage({ type: 'collapse', section: name, collapsed: c });
  };
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'section') {
      const body = secEl(m.name)?.querySelector('.body');
      if (body) { body.innerHTML = m.html; applyFolds(body); }
    } else if (m.type === 'sections') {
      for (const [name, c] of Object.entries(m.collapsed || {})) setCollapsed(name, c, false);
      for (const [name, on] of Object.entries(m.toggles || {})) document.querySelector('[data-hact="toggle:' + name + '"]')?.classList.toggle('on', on);
    } else if (m.type === 'expand') {
      setCollapsed(m.name, false, true);
      secEl(m.name)?.scrollIntoView({ block: 'nearest' });
    }
  });
  document.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-hact]');
    if (tool) return vscode.postMessage({ type: 'header', section: tool.closest('.sec').dataset.sec, act: tool.dataset.hact });
    const header = e.target.closest('header');
    if (header) { const sec = header.closest('.sec'); return setCollapsed(sec.dataset.sec, !sec.classList.contains('collapsed'), true); }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const node = el.closest('.node');
    if (el.dataset.act === 'fold') {
      const k = keyOf(node);
      if (folded.has(k)) folded.delete(k); else folded.add(k);
      save();
      applyFolds(node.closest('.body'));
    } else {
      vscode.postMessage({ type: el.dataset.act, key: node?.dataset.key, section: el.closest('.sec').dataset.sec });
    }
  });
  vscode.postMessage({ type: 'ready' });
`;

const CODICONS = () => vscode.Uri.joinPath(ctx.extensionUri, 'media', 'codicons');
/** Webview options: scripts, and the vendored codicon font (media/codicons, from @vscode/codicons). */
const webviewOptions = () => ({ enableScripts: true, localResourceRoots: [CODICONS()] });

/** A webview document with a nonce CSP for its inline script and VS Code's icon font (codicons). */
function webviewDoc(webview, css, body, script) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const icons = webview.asWebviewUri(vscode.Uri.joinPath(CODICONS(), 'codicon.css'));
  return `<!DOCTYPE html><html lang="${LANG}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${icons}"><style>${css}</style></head><body>${body}<script nonce="${nonce}">${script}</script></body></html>`;
}
/** A codicon: 'folder', 'loading~spin' (a ~spin suffix spins it, as in ThemeIcon ids). */
const codicon = (id) => `<i class="codicon codicon-${id.replace('~spin', ' codicon-modifier-spin')}"></i>`;

/**
 * One row of a list: a node with the row and its children.
 * @param {object} o { key, depth, title, tooltip, icon (a codicon id), cls, lines: [text], lineCls,
 *   acts: [{ act, title, icon }], x: { act, title, icon = 'close' } (last), kids: [html] }
 */
function rowHtml(o) {
  const kids = o.kids || [];
  const lines = (o.lines || []).filter(Boolean).map((l, i) => `<div class="line${i === o.lines.filter(Boolean).length - 1 && o.lineCls ? ' ' + o.lineCls : ''}">${escapeHtml(l)}</div>`).join('');
  return `<div class="node" data-key="${escapeHtml(o.key)}"><div class="row ${o.cls || ''}" style="--depth:${o.depth || 0}">` +
    `<span class="fold${kids.length ? '' : ' none'}" data-act="fold">${codicon('chevron-down')}</span>` +
    `<div class="main"><div class="title" data-act="open" title="${escapeHtml(o.tooltip || '')}"><span class="ico">${o.icon ? codicon(o.icon) : ''}</span>` +
    `<span class="name">${escapeHtml(String(o.title).slice(0, 300))}</span></div>${lines}</div>` +
    [...(o.acts || []), o.x && { icon: 'close', ...o.x }].filter(Boolean)
      .map((a) => `<button class="x" data-act="${a.act}" title="${escapeHtml(a.title)}">${codicon(a.icon)}</button>`).join('') +
    `</div><div class="kids">${kids.join('')}</div></div>`;
}
const emptyHtml = (text) => `<div class="empty">${escapeHtml(text)}</div>`;

/**
 * A part of the side bar: load() -> data, render(data) -> HTML, act(type, key) for clicks in it;
 * optionally header(act) -> true for its own header buttons, polls() -> false to skip the polling.
 */
class Section {
  constructor(name) {
    this.name = name;
    this.data = null;
  }
  refresh(force = false) { return sidebar?.refreshSection(this, force); }
  polls() { return true; }
}

/**
 * The side bar's webview view: the projects' list, then the History, Processes and Subagents
 * sections (collapsed ones are not loaded; which are collapsed is kept in the global state).
 */
class Sidebar {
  constructor(sections) {
    this.id = 'claudeWrapper.projects';
    this.view = null;
    this.sections = sections; // { projects, history, processes, agents, mcp }
    this.html = {};
    this.collapsed = new Set(ctx.globalState.get('sidebar.collapsed', ['processes', 'agents', 'mcp']));
  }
  resolveWebviewView(view) {
    this.view = view;
    this.html = {};
    view.webview.options = webviewOptions();
    view.webview.html = webviewDoc(view.webview, LIST_CSS, sidebarBody(), LIST_SCRIPT);
    view.webview.onDidReceiveMessage((m) => this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && this.refresh(true));
    view.onDidDispose(() => { this.view = null; });
  }
  get visible() { return !!this.view?.visible; }
  /** The section states (collapsed, the header toggles) to the view. */
  postState() {
    const collapsed = {};
    for (const name of ['history', 'processes', 'agents', 'mcp']) collapsed[name] = this.collapsed.has(name);
    const toggles = {};
    for (const n of filters.names) toggles[n] = filters.get(n);
    this.view?.webview.postMessage({ type: 'sections', collapsed, toggles });
  }
  /** The open sections; the polling (force = false) skips those that don't poll now. */
  async refresh(force = false) {
    for (const sec of Object.values(this.sections)) if (!this.collapsed.has(sec.name) && (force || sec.polls())) await this.refreshSection(sec, force);
  }
  async refreshSection(sec, force = false) {
    if (!this.view || this.collapsed.has(sec.name)) return;
    let html;
    try {
      sec.data = await sec.load();
      html = sec.render(sec.data);
    } catch (e) {
      html = emptyHtml(t('Error: {0}', e.message));
    }
    if (force || html !== this.html[sec.name]) {
      this.html[sec.name] = html;
      this.view?.webview.postMessage({ type: 'section', name: sec.name, html });
    }
    preview?.sync(sec);
  }
  /** Opens a section and scrolls to it (the counts under the chat's input ask for that). */
  expand(name) {
    this.view?.webview.postMessage({ type: 'expand', name });
  }
  async onMessage(m) {
    if (m?.type === 'ready') { this.html = {}; this.postState(); return this.refresh(true); }
    if (m?.type === 'collapse') {
      if (m.collapsed) this.collapsed.add(m.section); else this.collapsed.delete(m.section);
      await ctx.globalState.update('sidebar.collapsed', [...this.collapsed]);
      if (!m.collapsed) this.refreshSection(this.sections[m.section], true);
      return;
    }
    const sec = this.sections[m?.section];
    if (!sec) return;
    if (m.type === 'header') {
      if (sec.header?.(m.act)) return;
      if (m.act === 'newChat') return vscode.commands.executeCommand('claudeWrapper.newChat');
      if (m.act === 'refresh') return this.refreshSection(sec, true);
      const name = /^toggle:(\w+)$/.exec(m.act)?.[1];
      if (name && filters.names.includes(name)) {
        await filters.set(name, !filters.get(name));
        this.postState();
        return this.refreshSection(sec, true);
      }
      return;
    }
    sec.act(m.type, m.key);
  }
}

/** The side bar's skeleton: the projects' body, then the sections with their header buttons. */
function sidebarBody() {
  const tool = (act, icon, title) => `<button data-hact="${act}" title="${escapeHtml(title)}">${codicon(icon)}</button>`;
  const section = (name, label, tools) => `<section class="sec sub" data-sec="${name}"><div class="sash" title="${escapeHtml(t('Drag to change the height; double-click — even shares'))}"></div><header title="${escapeHtml(label)}">` +
    `<span class="chev">${codicon('chevron-down')}</span><span class="label">${escapeHtml(label)}</span><span class="tools">${tools}</span></header>` +
    `<div class="body"></div></section>`;
  return '<div class="layout"><div class="sec main" data-sec="projects"><div class="body"></div></div>' +
    section('history', t('History'), tool('newChat', 'add', t('New Chat')) + tool('refresh', 'refresh', t('Refresh'))) +
    section('processes', t('Processes'), tool('toggle:procFinished', 'history', t('Show Finished Processes')) +
      tool('toggle:procAllProjects', 'folder-library', t('Show Processes of All Projects')) + tool('refresh', 'refresh', t('Refresh'))) +
    section('agents', t('Subagents'), tool('toggle:agentFinished', 'history', t('Show Subagents Finished in the Last Hour')) +
      tool('toggle:agentAllProjects', 'folder-library', t('Show Subagents of All Projects')) + tool('refresh', 'refresh', t('Refresh'))) +
    section('mcp', t('MCP Servers'), tool('check', 'refresh', t('Check the MCP Servers'))) +
    '</div>';
}

// --- Projects: Claude Code's projects; a click opens the folder in VS Code ---

class ProjectsView extends Section {
  constructor() { super('projects'); }
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
        icon: !p.exists ? 'warning' : current ? 'folder-opened' : 'folder', cls: [current ? 'current' : '', p.exists ? '' : 'warn'].join(' '),
        lines: [
          (p.sessions ? t('{0} sess. · {1}', p.sessions, fmtDate(p.updated)) : t('no sessions')) + (p.exists ? '' : ' · ' + t('folder not found')),
          shortPath(p.cwd),
        ],
        lineCls: p.exists ? '' : 'state',
        acts: [
          p.exists && !current ? { act: 'window', title: t('Open in New Window'), icon: 'empty-window' } : null,
          p.dir ? { act: 'relink', title: t('Move History to Another Folder…'), icon: 'arrow-right' } : null,
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

class HistoryView extends Section {
  constructor() { super('history'); }
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
        icon: current ? 'comment-discussion' : 'comment', cls: current ? 'current' : '',
        lines: [t('{0} · {1} msg.', fmtDate(s.updated), s.messages), s.lastPrompt && s.lastPrompt !== s.title ? s.lastPrompt.replace(/\s+/g, ' ') : ''],
        x: { act: 'delete', title: t('Move Session to Trash'), icon: 'trash' },
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

class ProcessesView extends Section {
  constructor() { super('processes'); }
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
        icon: p.exited ? 'circle-slash' : orphan ? 'warning' : p.kind === 'claude' ? 'sparkle' : 'terminal',
        cls: [orphan ? 'warn' : '', p.exited ? 'dim' : ''].join(' '),
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

class AgentsView extends Section {
  constructor() { super('agents'); }
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
          icon: !a.ended ? 'loading~spin' : a.status === 'completed' ? 'check' : a.status === 'failed' ? 'error' : 'circle-slash',
          cls: a.ended ? 'dim' : '',
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
        key: 'r:' + rid, title: `“${info.prompt || t('run')}”`, tooltip: info.prompt || '', icon: 'sparkle', cls: info.alive ? '' : 'dim',
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

// --- MCP servers: those of the chat's Claude process while it runs, otherwise as last seen ---

const MCP_STATUS = { connected: t('connected'), pending: t('connecting'), 'needs-auth': t('needs sign-in'), failed: t('failed'), disabled: t('disabled') };
const MCP_ICON = { connected: 'pass', pending: 'loading~spin', 'needs-auth': 'key', failed: 'error', disabled: 'circle-slash' };
const MCP_SCOPE = { user: t('user'), project: t('project'), local: t('local'), plugin: t('plugin'), managed: t('managed'), enterprise: t('managed'), dynamic: t('dynamic'), claudeai: 'claude.ai', sdk: 'SDK' };
/** Where a server comes from: a plugin, or the settings it is configured in. */
const mcpScope = (s) => { const k = s.source || s.scope; return k ? MCP_SCOPE[k] || k : ''; };
/** What a server runs: its command line, or its address. */
function mcpWhere(s) {
  const c = s.config || {};
  if (c.url) return c.url;
  if (c.command) return [c.command, ...(c.args || [])].map(shortPath).join(' ');
  return s.urlHost || s.transport || '';
}
/** What can be done with a server in the chat's running process. */
const mcpActs = (s) => [
  s.status === 'needs-auth' ? { act: 'auth', label: t('Sign In'), title: t('Sign in to this MCP server (a browser opens)'), icon: 'key' } : null,
  s.status !== 'disabled' ? { act: 'reconnect', label: t('Reconnect'), title: t('Reconnect'), icon: 'debug-restart' } : null,
  s.status === 'disabled'
    ? { act: 'enable', label: t('Enable'), title: t('Enable the server'), icon: 'play' }
    : { act: 'disable', label: t('Disable'), title: t('Disable the server (Claude loses its tools)'), icon: 'circle-slash' },
].filter(Boolean);
const MCP_LIVE_ONLY = t('Servers can be enabled, disabled and reconnected while Claude runs in the chat');

/**
 * The MCP servers of the chat's project. While the chat's Claude process runs (it also waits
 * between messages) they come from it (mcp_status) and can be managed; otherwise the list is the
 * last one seen (the process's start, a check), kept per workspace, and the header's button checks
 * with a short process of its own. Polled only while a server of the running process is connecting.
 */
class McpView extends Section {
  constructor() {
    super('mcp');
    this.last = ctx.workspaceState.get('mcp.last', null); // { cwd, at, how: 'run' | 'check', servers }
    this.checking = false;
    this.asked = { runId: null, at: 0 };
  }
  cwd() { return chat?.state.cwd || folder(); }
  runId() { return chat?.state.runId || null; }
  servers() { return this.last && this.last.cwd === this.cwd() ? this.last.servers : null; }
  polls() { return !!this.runId() && !!this.servers()?.some((s) => s.status === 'pending'); }
  remember(servers, how) {
    if (!Array.isArray(servers)) return;
    this.last = { cwd: this.cwd(), at: Date.now(), how, servers };
    ctx.workspaceState.update('mcp.last', this.last);
  }
  /** Asks the chat's running process (at most once a second); false when none runs. */
  async ask() {
    const runId = this.runId();
    if (!runId) return false;
    if (this.asked.runId === runId && Date.now() - this.asked.at < 1000) return true;
    this.asked = { runId, at: Date.now() };
    try {
      const d = await postJson('/api/chat/control', { runId, request: { subtype: 'mcp_status' } });
      this.remember(d.mcpServers, 'run');
      return true;
    } catch {
      return false; // the process has just ended: the last list stays
    }
  }
  async load() {
    await this.ask();
    return this.servers();
  }
  /** The header's button: the running process's answer, or a short process for the check (seconds). */
  async check() {
    if (this.checking) return;
    if (!(await this.ask())) {
      this.checking = true;
      this.refresh(true);
      try {
        const d = await postJson('/api/session/control', { cwd: this.cwd(), request: { subtype: 'mcp_status' } });
        this.remember(d.mcpServers, 'check');
      } catch (e) {
        vscode.window.showErrorMessage(t('Could not check the MCP servers: {0}', e.message));
      } finally {
        this.checking = false;
      }
    }
    await this.refresh(true);
    preview?.sync(this);
  }
  header(act) {
    if (act !== 'check') return false;
    this.check();
    return true;
  }
  render(servers) {
    const live = !!this.runId();
    let h = this.checking ? `<div class="note">${codicon('loading~spin')}${escapeHtml(t('Checking…'))}</div>` : '';
    if (!servers) return h + (this.checking ? '' : emptyHtml(t('No data yet: Claude reports its MCP servers when it starts in the chat — or check now')));
    if (!servers.length) return h + emptyHtml(t('No MCP servers are configured for this project'));
    if (!live && !this.checking) h += `<div class="note" title="${escapeHtml(MCP_LIVE_ONLY)}">${escapeHtml(t('As of {0}', fmtDate(this.last.at)))}</div>`;
    return h + servers.map((s) => {
      const tools = s.tools?.length ?? s.toolCount;
      return rowHtml({
        key: 'm:' + s.name, title: s.name, tooltip: s.error || mcpWhere(s) || s.name,
        icon: MCP_ICON[s.status] || 'circle-large-outline', cls: 'mcp-' + s.status + (s.status === 'disabled' ? ' dim' : ''),
        lines: [
          [MCP_STATUS[s.status] || s.status, s.status === 'connected' && tools != null ? t('tools: {0}', tools) : '', mcpScope(s)].filter(Boolean).join(' · '),
          s.error || mcpWhere(s),
        ],
        lineCls: s.error ? 'state' : '',
        acts: live ? mcpActs(s) : [],
      });
    }).join('');
  }
  act(type, key) {
    const s = this.servers()?.find((x) => 'm:' + x.name === key);
    if (!s) return;
    if (type === 'open') Preview.show(new McpSubject(s));
    else mcpAction(s, type);
  }
}

/** Sign in, reconnect, enable or disable a server of the chat's running process. */
async function mcpAction(s, type) {
  const request = { auth: { subtype: 'mcp_authenticate' }, reconnect: { subtype: 'mcp_reconnect' }, enable: { subtype: 'mcp_toggle', enabled: true }, disable: { subtype: 'mcp_toggle', enabled: false } }[type];
  if (!request) return;
  const runId = mcpView.runId();
  if (!runId) return vscode.window.showInformationMessage(MCP_LIVE_ONLY);
  // A reconnect waits for the connection: the view's progress bar meanwhile.
  await vscode.window.withProgress({ location: { viewId: sidebar.id } }, async () => {
    try {
      const r = await postJson('/api/chat/control', { runId, request: { ...request, serverName: s.name } });
      // OAuth: the CLI gives the sign-in address; the browser comes back to the CLI itself.
      if (r?.authUrl) vscode.env.openExternal(vscode.Uri.parse(r.authUrl));
    } catch (e) {
      vscode.window.showErrorMessage(t('MCP server “{0}”: {1}', s.name, e.message));
    }
    mcpView.asked.at = 0;
    await mcpView.ask();
  });
  await mcpView.refresh(true);
  preview?.sync(mcpView);
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
    this.panel = vscode.window.createWebviewPanel('claudeWrapper.preview', '', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, webviewOptions());
    this.panel.iconPath = vscode.Uri.file(path.join(__dirname, 'resources', 'icon.png'));
    this.panel.webview.html = webviewDoc(this.panel.webview, DETAIL_CSS, '<div id="root"></div>', DETAIL_SCRIPT);
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

/** The first sentence of a tool's description, for the list (the whole one is its tooltip). */
const firstSentence = (text) => {
  const line = String(text).trim().split(/\n/)[0];
  const m = /^(.{20,}?[.!?])\s/.exec(line + ' ');
  return (m ? m[1] : line).slice(0, 200);
};

class McpSubject {
  constructor(s) { this.s = s; this.key = 'm:' + s.name; }
  title() { return `MCP · ${this.s.name}`; }
  live() { return false; }
  /** Cheap: asks the running process only; a check without one is the "Check" button. */
  async refresh() {
    await mcpView.ask();
    this.take();
  }
  take() {
    const fresh = mcpView.servers()?.find((x) => x.name === this.s.name);
    if (!fresh || JSON.stringify(fresh) === JSON.stringify(this.s)) return false;
    this.s = fresh;
    return true;
  }
  sync(view) { return view === mcpView && this.take(); }
  html() {
    const s = this.s, c = s.config || {};
    const live = !!mcpView.runId();
    let h = `<h2>${esc(s.name)}</h2><div class="sub${s.status === 'failed' ? ' warn' : ''}">${esc(['MCP', MCP_STATUS[s.status] || s.status, mcpScope(s)].filter(Boolean).join(' · '))}</div>`;
    h += '<div class="bar">' + (live ? mcpActs(s).map((a) => button(a.act, a.label)).join('') + button('refresh', t('Refresh')) : button('check', t('Check the MCP Servers'))) + '</div>';
    if (!live && mcpView.last) h += `<p class="note">${esc(t('As of {0}', new Date(mcpView.last.at).toLocaleString(LOCALE)))}. ${esc(MCP_LIVE_ONLY)}.</p>`;
    h += table([
      [t('State'), MCP_STATUS[s.status] || s.status],
      s.serverInfo ? [t('Server'), `${s.serverInfo.name} ${s.serverInfo.version}`] : null,
      c.type || s.transport ? [t('Type'), c.type || s.transport] : null,
      c.url ? ['URL', c.url] : null,
      mcpScope(s) ? [t('Configured in'), mcpScope(s)] : null,
    ]);
    if (c.command) h += `<h3>${esc(t('Command'))}</h3><pre>${esc([c.command, ...(c.args || [])].join(' '))}</pre>`;
    if (s.error) h += `<h3 class="warn">${esc(t('Error'))}</h3><pre>${esc(s.error)}</pre>`;
    if (s.tools?.length) {
      const mark = (x) => [x.annotations?.readOnly ? t('read-only') : '', x.annotations?.destructive ? t('destructive') : ''].filter(Boolean).join(', ');
      h += `<h3>${esc(t('Tools ({0})', s.tools.length))}</h3><ul>` + s.tools.map((x) =>
        `<li title="${esc(x.description || '')}"><b>${esc(x.name)}</b>${mark(x) ? ` <span class="note">(${esc(mark(x))})</span>` : ''}${x.description ? ' — ' + esc(firstSentence(x.description)) : ''}</li>`).join('') + '</ul>';
    } else if (s.toolCount) {
      h += table([[t('Tools'), String(s.toolCount)]]);
    }
    return h;
  }
  act(type) {
    if (type === 'check') mcpView.check();
    else mcpAction(this.s, type);
  }
}

// ---------------------------------------------------------------------------------------------
// Chat: the page (server/public/index.html) right in a webview view (secondary side bar). Its
// fetch('/api/...') comes here as messages (public/vscode-shim.js) and goes to the server's routes.

const TEXT_TYPE = /^(text\/|application\/(json|x-ndjson|javascript))/i;

/**
 * The chat's voice: the TTS / STT MD Aloud extension, when installed, speaks the page's phrases
 * with the voice, speed and volume of its settings (its API: tts.speak / stop, settings(),
 * onDidChangeSettings). The page asks with { type: 'tts', op: 'speak', id, text, lang, priority,
 * resumeText, resumeLang, next } and gets { type: 'tts', id, done } or { id, error }. It queues the
 * speaker among the windows of VS Code: a phrase waits for its turn (`next` keeps the speaker for
 * the phrase to come); a higher `priority` pauses one being played, which goes on after `resumeText`. 'stop' ends its phrase, 'settings' shows the
 * extension's side bar; { type: 'ttsInfo', info: { available, enabled, driver, langs, stt: { enabled } } } tells
 * it whether to use it (without it the page speaks with the system voice itself and has no
 * microphone). The microphone: { type: 'stt', op: 'start', id } listens (ChatView.listen), answers
 * { type: 'stt', id, event: 'ready' | 'result' | 'error' | 'end', text, error, message }; 'stop' ends it.
 */
const ALOUD_ID = 'ninebits.tts-stt-md-aloud';
/** The Mac's default sound output, { label } or null: the page tells headphones from speakers by it. */
let audioQuery = null;
function defaultAudioOutput() {
  audioQuery ||= new Promise((resolve) => {
    execFile('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      audioQuery = null;
      try {
        const device = JSON.parse(out).SPAudioDataType.flatMap((group) => group._items || []).find((item) => item.coreaudio_default_audio_output_device === 'spaudio_yes');
        resolve(device ? { label: device._name } : null);
      } catch {
        resolve(null);
      }
    });
  });
  return audioQuery;
}

const MIC_WAIT_MS = 8000; // of silence, in one recording
const MIC_TURN_MS = 300;  // TTS / STT MD Aloud's waiters look at the microphone every 100 ms and settle for 100 ms
const micTurn = () => new Promise((resolve) => setTimeout(resolve, MIC_TURN_MS));

const aloud = {
  api: null,
  watch: null,
  gen: 0, // bumped by stop(): a phrase asked for before it is not spoken
  onChange: () => {},
  /** Its API, activating it on first use; null when it isn't installed (or fails to start). */
  async get() {
    const ext = vscode.extensions.getExtension(ALOUD_ID);
    if (!ext) return (this.api = null);
    if (!this.api) {
      try {
        this.api = ext.isActive ? ext.exports : await ext.activate();
      } catch (e) {
        console.warn(`[claude-wrapper] ${ALOUD_ID}: ${e.message}`);
        return null;
      }
      this.watch?.dispose();
      this.watch = this.api?.onDidChangeSettings?.(() => this.onChange()) || null;
    }
    return this.api?.tts ? this.api : null;
  },
  async info() {
    const api = await this.get();
    if (!api) return { available: false };
    let tts = {}, stt = {}, langs = [];
    try { ({ tts = {}, stt = {} } = api.settings?.() || {}); } catch {}
    // The languages its offered voices speak: a phrase in another one goes in VS Code's or English.
    try { langs = [...new Set((await api.tts.voices()).map((v) => String(v.lang || '').slice(0, 2).toLowerCase()).filter(Boolean))]; } catch {}
    return { available: true, enabled: tts.enabled !== false, driver: tts.driver || 'system', langs, stt: { enabled: stt.enabled === true } };
  },
  /** Ends the phrase it speaks for the chat (only the speech asked for through its API). */
  stop() {
    this.gen++;
    try { this.api?.tts.stop(); } catch {}
  },
  /** Ends the recording made for the chat. */
  stopMic() {
    try { this.api?.stt?.stop(); } catch {}
  },
  /** Installed, removed or updated: its API is asked for again. */
  reset() {
    this.stop();
    this.stopMic();
    this.watch?.dispose();
    this.watch = null;
    this.api = null;
  },
};

class ChatView {
  constructor() {
    this.view = null;
    this.ready = false;
    this.queue = [];
    this.requests = new Map(); // the page's open fetches: id -> { abort }
    this.state = { cwd: null, sessionId: null, title: '', runId: null };
    this.onState = () => {};
    this.onMcp = () => {};
    this.mic = null; // the page's listening under way: { id }
  }
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(PUBLIC_DIR)] };
    view.webview.onDidReceiveMessage((m) => this.fromPage(m));
    view.onDidDispose(() => { this.endRequests(); aloud.stop(); this.stopMic(); this.view = null; this.ready = false; });
    this.load();
  }
  load() {
    if (!this.view) return;
    this.ready = false;
    this.endRequests();
    aloud.stop();
    this.stopMic();
    this.view.webview.html = chatHtml(this.view.webview);
  }
  /** Ends the page's open requests (a chat's run ends with its stream, as with a closed connection). */
  endRequests() {
    for (const r of this.requests.values()) r.abort();
    this.requests.clear();
  }
  /** To the page, or queued until it says it is ready. */
  post(msg) {
    if (this.view && this.ready) this.view.webview.postMessage({ target: 'claude-wrapper', ...msg });
    else this.queue.push(msg);
  }
  async reveal() {
    await vscode.commands.executeCommand('claudeWrapper.chat.focus');
  }
  /** A fetch of the page: run by the server's handler, its answer streamed back (text as text). */
  fetchFromPage({ id, method, url, headers, body }) {
    const send = (msg) => this.view?.webview.postMessage({ type: 'http', id, ...msg });
    let decoder = null;
    const handle = inproc.request(server.handleRequest, { method, url, headers, body }, {
      head: (status, h) => {
        if (TEXT_TYPE.test(String(h['content-type'] || ''))) decoder = new (require('string_decoder').StringDecoder)('utf8');
        send({ phase: 'head', status, headers: h });
      },
      chunk: (buf) => send(decoder ? { phase: 'chunk', chunk: decoder.write(buf) } : { phase: 'chunk', b64: buf.toString('base64') }),
      end: () => {
        const rest = decoder?.end();
        if (rest) send({ phase: 'chunk', chunk: rest });
        this.requests.delete(id);
        send({ phase: 'end' });
      },
    });
    this.requests.set(id, handle);
  }
  stopMic() {
    if (!this.mic) return;
    this.mic = null;
    aloud.stopMic();
  }
  /**
   * The page's microphone: TTS / STT MD Aloud records a phrase and recognizes it, again and again
   * until the page stops it (a phrase stopped midway is dropped). The microphone is queued among
   * the windows, so a recording holds it only for MIC_WAIT_MS of silence and it is left free for
   * MIC_TURN_MS after each one: a window waiting for it gets its turn. A person taking it over
   * (Dictate, Test microphone) ends a recording, which is no phrase then. Any failure but a busy
   * microphone (TTS / STT MD Aloud before 1.5.0 rejects then) ends the listening with its reason.
   */
  async listen(id) {
    this.stopMic();
    const run = (this.mic = { id });
    const send = (ev) => this.view?.webview.postMessage({ target: 'claude-wrapper', type: 'stt', id, ...ev });
    const fail = (message) => send({ event: 'error', error: 'host', message });
    const api = await aloud.get();
    if (this.mic !== run) return;
    if (!api?.stt) fail(t('the extension is not available'));
    else send({ event: 'ready' });
    while (api?.stt && this.mic === run) {
      let heard;
      try {
        heard = await api.stt.record({ waitMs: MIC_WAIT_MS, maxMs: 60000, silenceMs: 1200 });
      } catch (e) {
        if (/busy/i.test(e.message)) { await micTurn(); continue; }
        if (this.mic === run) fail(e.message || String(e));
        break;
      }
      if (this.mic !== run) return;
      const interrupted = heard.ended === 'interrupted';
      const text = interrupted ? '' : heard.text?.trim();
      // Whisper names what isn't speech in brackets ("[BLANK_AUDIO]", "(music)"): not a phrase.
      if (text && !/^[[(*♪].*[\])*♪]$/.test(text)) send({ event: 'result', text });
      else if (heard.error && !interrupted) { fail(heard.error); break; }
      await micTurn();
    }
    if (this.mic === run) { this.mic = null; send({ event: 'end' }); }
  }
  /** Whether TTS / STT MD Aloud speaks for the page, and its settings. */
  async postTtsInfo() {
    this.post({ type: 'ttsInfo', info: await aloud.info() });
  }
  /** The page's speech through TTS / STT MD Aloud (see `aloud`). */
  async speech(m) {
    if (m.op === 'stop') return aloud.stop();
    if (m.op === 'settings') {
      return vscode.commands.executeCommand('tts-stt-md-aloud.speech.focus')
        .then(undefined, () => vscode.commands.executeCommand('workbench.action.openSettings', '@ext:' + ALOUD_ID));
    }
    if (m.op !== 'speak' || typeof m.text !== 'string') return;
    const reply = (r) => this.view?.webview.postMessage({ target: 'claude-wrapper', type: 'tts', id: m.id, ...r });
    const gen = aloud.gen;
    const api = await aloud.get();
    if (!api) { this.postTtsInfo(); return reply({ error: t('the extension is not available') }); }
    if (gen !== aloud.gen) return reply({ done: false }); // stopped while it was starting
    const next = m.next && typeof m.next.text === 'string' ? { text: m.next.text, lang: m.next.lang } : undefined;
    try {
      reply({ done: await api.tts.speak(m.text, {
        lang: m.lang,
        priority: [0, 1, 2].includes(m.priority) ? m.priority : 0,
        ...(typeof m.resumeText === 'string' ? { resumeText: m.resumeText, resumeLang: m.resumeLang } : {}),
        ...(next ? { next } : {}),
      }) });
    } catch (e) {
      reply({ error: e.message || String(e) });
    }
  }
  fromPage(m) {
    if (m?.type === 'http') return this.fetchFromPage(m);
    if (m?.type === 'httpAbort') { this.requests.get(m.id)?.abort(); this.requests.delete(m.id); return; }
    if (m?.type === 'httpReset') return this.endRequests();
    if (!m || m.source !== 'claude-wrapper') return;
    if (m.type === 'ready') {
      this.ready = true;
      for (const q of this.queue.splice(0)) this.post(q);
      this.postTtsInfo();
      this.post({ type: 'windowFocus', focused: vscode.window.state.focused });
    } else if (m.type === 'tts') {
      this.speech(m);
    } else if (m.type === 'stt') {
      if (m.op === 'stop') this.stopMic();
      else if (m.op === 'start') this.listen(m.id);
    } else if (m.type === 'audioOut') {
      defaultAudioOutput().then((device) => this.post({ type: 'audioOut', device }));
    } else if (m.type === 'state') {
      this.state = { cwd: m.cwd, sessionId: m.sessionId, title: m.title, busy: !!m.busy, runId: m.runId || null };
      this.onState();
    } else if (m.type === 'mcp' && Array.isArray(m.servers)) {
      this.onMcp(m.servers);
    } else if (m.type === 'showView' && ['processes', 'agents', 'history'].includes(m.view)) {
      // From the counts under the chat's input: the side bar shown, that section opened.
      vscode.commands.executeCommand('claudeWrapper.projects.focus').then(() => sidebar.expand(m.view));
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

/**
 * The chat page for the webview: index.html as it is on disk, with a CSP (its inline scripts get a
 * nonce), window.CW (what a browser reads from the URL), the fetch shim first and i18n.js from the
 * extension's files.
 */
function chatHtml(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const uri = (name) => webview.asWebviewUri(vscode.Uri.file(path.join(PUBLIC_DIR, name)));
  const src = webview.cspSource;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${src} 'unsafe-inline'; img-src ${src} data: blob: https:; ` +
    `media-src ${src} data: blob:; font-src ${src} data:; connect-src ${src} data: blob:;`;
  const params = { embed: 'vscode', lang: LANG, ...(folder() ? { cwd: folder() } : {}) };
  const head = `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `<script nonce="${nonce}">window.CW = ${JSON.stringify(params).replace(/</g, '\\u003c')};</script>\n` +
    `<script nonce="${nonce}" src="${uri('vscode-shim.js')}"></script>\n`;
  return fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8')
    .replace('<script src="i18n.js"></script>', `<script src="${uri('i18n.js')}"></script>`)
    .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`)
    .replace(/<head>/, `<head>\n${head}`);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    sidebar.refresh(true);
    if (choice === open) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(r.cwd), { forceNewWindow: false });
  } catch (e) {
    vscode.window.showErrorMessage(t('Could not move the history: {0}', e.message));
  }
}

let sidebar = null;
let historyView = null, processesView = null, agentsView = null, mcpView = null;

/**
 * Toggles of the Processes and Subagents sections (buttons in their headers), kept per workspace:
 * procFinished / agentFinished — finished ones too (subagents: of the last hour);
 * procAllProjects / agentAllProjects — every project, not only this window's folder (processes: on
 * by default).
 */
const filters = {
  names: ['procFinished', 'procAllProjects', 'agentFinished', 'agentAllProjects'],
  // Processes of every project by default: what runs on the machine matters, wherever it came from.
  defaults: { procAllProjects: true },
  get(name) { return !!ctx.workspaceState.get('filter.' + name, !!this.defaults[name]); },
  set(name, value) { return ctx.workspaceState.update('filter.' + name, value); },
};

function activate(context) {
  ctx = context;
  startServer(context);

  chat = new ChatView();
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('claudeWrapper.chat', chat, { webviewOptions: { retainContextWhenHidden: true } }));
  // The chat's voice: TTS / STT MD Aloud's settings changed, or it was installed / removed.
  aloud.onChange = () => chat.postTtsInfo();
  context.subscriptions.push(vscode.extensions.onDidChange(() => { aloud.reset(); chat.postTtsInfo(); }), { dispose: () => aloud.reset() });
  context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => chat.post({ type: 'windowFocus', focused: state.focused })));

  historyView = new HistoryView();
  processesView = new ProcessesView();
  agentsView = new AgentsView();
  mcpView = new McpView();
  sidebar = new Sidebar({ projects: new ProjectsView(), history: historyView, processes: processesView, agents: agentsView, mcp: mcpView });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(sidebar.id, sidebar));
  let chatRun = null;
  chat.onState = () => {
    historyView.refresh(true); // the open session gets its mark
    // The chat's Claude process started or ended: its MCP servers, managed or not.
    if (chat.state.runId !== chatRun) { chatRun = chat.state.runId; mcpView.refresh(true); }
  };
  // A process's start reports its servers (names and states); the process itself then tells the rest.
  chat.onMcp = (servers) => { mcpView.remember(servers, 'run'); mcpView.asked.at = 0; mcpView.refresh(true); };
  const timer = setInterval(() => sidebar.visible && sidebar.refresh(), POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    if (folder()) chat.post({ type: 'setProject', cwd: folder() });
    sidebar.refresh(true);
  }));

  const cmd = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('claudeWrapper.refresh', () => sidebar.refresh(true));
  cmd('claudeWrapper.newChat', async () => { await chat.reveal(); chat.post({ type: 'newChat' }); });
  cmd('claudeWrapper.openProject', openProject);
  cmd('claudeWrapper.openProjectNewWindow', (p) => p?.cwd && vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(p.cwd), { forceNewWindow: true }));
  cmd('claudeWrapper.relinkProject', (p) => p?.dir && relinkProject(p));
  cmd('claudeWrapper.openSession', (s) => s?.id && openSessionInChat(s.id, s.title || ''));
  cmd('claudeWrapper.deleteSession', (session) => session?.id && deleteSession(session));
  cmd('claudeWrapper.stopProcess', (p) => p?.pid && stopProcess(p));
  cmd('claudeWrapper.stopAgent', (a) => a?.id && stopAgent(a));
}

function deactivate() {
  // The window goes: its chats' claude runs end (as when their page closed), the registry is saved.
  aloud.stop();
  chat?.stopMic();
  server?.stop();
}

module.exports = { activate, deactivate };
