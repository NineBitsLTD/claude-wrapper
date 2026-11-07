'use strict';
/**
 * Control requests of the claude CLI in stream-json mode (the protocol the Agent SDK and the
 * VS Code extension use): { type: 'control_request', request_id, request: { subtype, ... } } on
 * stdin, answered by { type: 'control_response', response: { subtype: 'success'|'error',
 * request_id, response?, error? } } on stdout.
 *
 * - attach(run): a running chat process gets run.control(request) -> Promise<response>.
 * - onEvent(run, ev): routes the CLI's control traffic; its can_use_tool requests (permission
 *   prompts) go to run.onCanUseTool(request, requestId) -> Promise<PermissionResult | null>, its
 *   elicitation requests (an MCP server asks the user) to run.onElicitation -> Promise<{ action,
 *   content } | null>, a control_cancel_request to run.onCancelRequest(requestId).
 * - oneShot(...): a short-lived process resumes a session only to send control requests
 *   (rewind files, context usage, titles) when no chat run is active.
 */
const crypto = require('crypto');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const TIMEOUT_MS = 20000;

// What the page may ask for. Anything else (login, plugins…) is not exposed; of the settings only
// effort/ultracode can be changed (apply_flag_settings, checked in server.js) and read (get_settings).
// Tasks: stop one, move the foreground ones to the background (Ctrl+B), read a shell's output.
// Also: withdraw a queued message, /btw (side_question), MCP servers (toggle, reconnect, sign in),
// read-only views (permission rules, hooks, /status, plan, cost, export), output style
// (update_settings, only that key — checked in server.js), reloading skills/plugins/styles.
const RUN_SUBTYPES = new Set([
  'interrupt', 'set_model', 'set_permission_mode', 'get_context_usage', 'mcp_status', 'apply_flag_settings', 'get_settings',
  'stop_task', 'background_tasks', 'get_task_output', 'cancel_async_message', 'side_question',
  'mcp_toggle', 'mcp_reconnect', 'mcp_authenticate',
  'list_permission_rules', 'get_hooks_listing', 'get_status', 'get_session_cost', 'get_plan', 'export_conversation',
  'update_settings', 'reload_skills', 'reload_plugins', 'reload_output_styles',
]);
const SESSION_SUBTYPES = new Set([
  'rewind_files', 'get_context_usage', 'rename_session', 'generate_session_title', 'mcp_status', 'side_question',
  'list_permission_rules', 'get_hooks_listing', 'get_status', 'get_plan', 'export_conversation', 'update_settings',
  'get_settings',
]);
// Of those, the ones about the project rather than a session: no session is resumed for them.
const PROJECT_SUBTYPES = new Set(['mcp_status', 'generate_session_title', 'list_permission_rules', 'get_hooks_listing', 'get_status', 'update_settings', 'get_settings']);

/** Adds run.control() to a chat run whose child is the CLI process. */
function attach(run) {
  run.controlPending = new Map();
  run.control = (request, timeoutMs = TIMEOUT_MS) => new Promise((resolve, reject) => {
    if (!run.child.stdin.writable) return reject(new Error('The Claude process is already ending'));
    const id = 'cw_' + crypto.randomUUID();
    const timer = setTimeout(() => { run.controlPending.delete(id); reject(new Error('The CLI did not answer')); }, timeoutMs);
    run.controlPending.set(id, { resolve, reject, timer });
    run.child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
  });
  run.child.on('close', () => {
    for (const p of run.controlPending.values()) { clearTimeout(p.timer); p.reject(new Error('The Claude process has ended')); }
    run.controlPending.clear();
  });
}

/**
 * Handles control traffic in the CLI's stdout. Returns true when the event was consumed
 * (it is then not forwarded to the page).
 */
function onEvent(run, ev) {
  if (ev.type === 'control_response') {
    const r = ev.response || {};
    const p = run.controlPending?.get(r.request_id);
    if (!p) return true;
    run.controlPending.delete(r.request_id);
    clearTimeout(p.timer);
    if (r.subtype === 'error') p.reject(new Error(r.error || 'CLI error'));
    else p.resolve(r.response || {});
    return true;
  }
  if (ev.type === 'control_request') {
    const reply = (response) => run.child.stdin.writable && run.child.stdin.write(JSON.stringify({ type: 'control_response', response: { request_id: ev.request_id, ...response } }) + '\n');
    // Permission prompts (--permission-prompt-tool stdio) and MCP servers' forms (elicitation): the
    // host asks the user. null = withdrawn.
    const ask = { can_use_tool: run.onCanUseTool, elicitation: run.onElicitation }[ev.request?.subtype];
    if (ask) {
      Promise.resolve(ask(ev.request, ev.request_id)).then(
        (result) => result && reply({ subtype: 'success', response: result }),
        (e) => reply({ subtype: 'error', error: e.message }),
      );
      return true;
    }
    // Other requests from the CLI to its host (hooks, SDK MCP…): this host offers none of them.
    reply({ subtype: 'error', error: 'Not supported by claude-web' });
    return true;
  }
  // The CLI no longer needs an answer (e.g. the tool call was interrupted): close its prompt.
  if (ev.type === 'control_cancel_request') {
    run.onCancelRequest?.(ev.request_id);
    return true;
  }
  return false;
}

/**
 * Starts `claude -p --resume <sessionId>` without a prompt, sends `requests` one after another
 * and exits. Resolves to the list of responses (an { error } entry for a failed one).
 */
function oneShot({ claudeBin, cwd, sessionId, requests, env, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    const child = spawn(claudeBin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const results = new Array(requests.length);
    const ids = requests.map((_, i) => `cw_${i}_${crypto.randomUUID()}`);
    let left = requests.length;
    let stderr = '';
    const decoder = new StringDecoder('utf8');
    let buf = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('The CLI did not answer')); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stderr.on('data', (c) => { stderr += c; });
    child.stdout.on('data', (c) => {
      buf += decoder.write(c);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        let ev;
        try { ev = JSON.parse(buf.slice(0, nl)); } catch { ev = null; }
        buf = buf.slice(nl + 1);
        if (ev?.type !== 'control_response') continue;
        const r = ev.response || {};
        const i = ids.indexOf(r.request_id);
        if (i < 0) continue;
        results[i] = r.subtype === 'error' ? { error: r.error || 'CLI error' } : r.response || {};
        if (--left === 0) child.stdin.end();
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (left > 0) return reject(new Error(stderr.trim().split('\n').pop() || `The CLI exited with code ${code}`));
      resolve(results);
    });
    requests.forEach((request, i) => child.stdin.write(JSON.stringify({ type: 'control_request', request_id: ids[i], request }) + '\n'));
  });
}

module.exports = { attach, onEvent, oneShot, RUN_SUBTYPES, SESSION_SUBTYPES, PROJECT_SUBTYPES };
