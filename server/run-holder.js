'use strict';
/**
 * Holds one chat's claude process outside the VS Code window, so that it survives a reload of the
 * window (the extension host goes, and with it every pipe it owned). Started detached by
 * held-run.js, one per run; plain Node (in VS Code: its Electron binary as Node), no dependencies.
 *
 * Its settings come as JSON on stdin (they carry the environment of claude, so not on the command
 * line). It owns claude's pipes and listens on a Unix socket; claude starts when the first client
 * connects. One client at a time, newline-delimited JSON:
 *   client -> { op: 'state' } | { op: 'in', d: text for stdin } | { op: 'end' } | { op: 'kill', signal }
 *   holder -> { o: stdout line } | { e: stderr text } | { err: message } | { x: [code, signal] }
 *             | { paused: true | false } | { state: what a client coming back needs to know }
 * What a client that comes back needs: the deltas of the message being written (the finished
 * messages are in the session's transcript) and the prompts still waiting for an answer.
 *
 * Without a client claude goes on working for GRACE_MS (a reload takes seconds, a closed window
 * doesn't come back), then it is stopped. The record of the run (<data dir>/.run/holders/) is what
 * the next extension host finds it by; it goes when claude does.
 *
 * Sleep: the machine stops everything by itself, but between its naps (dark wakes, no display and
 * often no network) processes run for a few seconds and a claude in the middle of a request would
 * spend its retries there. A late tick means the machine slept: a working claude gets SIGSTOP and
 * SIGCONT once the machine is fully awake and the API's host resolves.
 */
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const { spawn, execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const GRACE_MS = 3 * 60000;
const FIRST_CLIENT_MS = 30000;
const PARTIAL_LIMIT = 8 * 1024 * 1024;
const TICK_MS = 1000;
const SLEPT_AFTER_MS = 5000; // a tick this late: the machine was asleep
const CHECK_MS = 3000; // while paused: how often to look whether claude can go on
const WAIT_LIMIT_MS = 30 * 60000; // of running time: a check that can't succeed must not hold claude for ever
const ASKS = new Set(['can_use_tool', 'elicitation']);

process.on('uncaughtException', (e) => console.error(new Date().toISOString(), e.stack || e));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => main(JSON.parse(input)));

/** What to resolve to know the network is back: the proxy, a custom endpoint, or the API itself. */
function hostToCheck(env) {
  try { return new URL(env.HTTPS_PROXY || env.https_proxy || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').hostname; } catch { return 'api.anthropic.com'; }
}

function fullyAwake() {
  return new Promise((resolve) => {
    // In a dark wake the capabilities are "CPU Network", without Graphics.
    execFile('/usr/bin/pmset', ['-g', 'systemstate'], { timeout: 4000 }, (e, out) => resolve(e ? true : /Graphics/.test(out)));
  });
}

function resolves(host) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    dns.lookup(host, (e) => { clearTimeout(timer); resolve(!e); });
  });
}

function main({ bin, args, cwd, env, sock, recordFile, logFile, runId, prompt, sessionId }) {
  const record = { runId, cwd, prompt, sessionId: sessionId || null, sock, holder: process.pid, claude: null };
  const saveRecord = () => { try { fs.writeFileSync(recordFile, JSON.stringify(record), { mode: 0o600 }); } catch (e) { console.error(e.message); } };

  let child = null;
  let client = null;
  let graceTimer = null;
  let exited = null;
  let spawnError = null;
  let leaving = false;
  // What a client coming back gets: the last init and task list, the deltas of the message being
  // written, the prompts without an answer.
  let init = null, tasks = null, partial = [], partialBytes = 0;
  const open = new Map();
  let turn = true; // the first message is on its way
  let agents = 0;
  let paused = false, checking = false, nextCheck = 0, waited = 0, lastTick = Date.now();

  const send = (frame) => { if (client && !client.destroyed) client.write(JSON.stringify(frame) + '\n'); };
  const busy = () => turn || agents > 0;
  const stateFrame = () => ({ state: { pid: child?.pid || null, busy: busy(), paused, exited, error: spawnError, init, tasks, open: [...open.values()], partial } });
  const clearPartial = () => { partial = []; partialBytes = 0; };

  function leave() {
    if (leaving) return;
    leaving = true;
    for (const f of [recordFile, logFile, sock]) { try { fs.unlinkSync(f); } catch {} }
    setTimeout(() => process.exit(0), client ? 300 : 0);
  }

  /** Follows the stream for what a returning client needs; the main agent's messages only. */
  function note(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id && ev.session_id !== record.sessionId) { record.sessionId = ev.session_id; saveRecord(); }
    if (ev.parent_tool_use_id) return;
    switch (ev.type) {
      case 'stream_event':
        turn = true;
        partial.push(line);
        partialBytes += line.length;
        while (partialBytes > PARTIAL_LIMIT && partial.length) partialBytes -= partial.shift().length;
        break;
      case 'assistant':
        turn = true;
        clearPartial();
        break;
      case 'user':
        if (ev.isReplay) turn = true;
        clearPartial();
        break;
      case 'result':
        turn = false;
        clearPartial();
        break;
      case 'control_request':
        if (ASKS.has(ev.request?.subtype)) open.set(ev.request_id, line);
        break;
      case 'control_cancel_request':
        open.delete(ev.request_id);
        break;
      case 'system':
        if (ev.subtype === 'init') init = line;
        else if (ev.subtype === 'background_tasks_changed') {
          tasks = line;
          agents = (ev.tasks || []).filter((t) => t.task_type === 'local_agent').length;
        }
        break;
    }
  }

  function start() {
    child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    record.claude = child.pid || null;
    saveRecord();
    child.stdin.on('error', () => {}); // EPIPE if claude exits while we write
    const decoder = new StringDecoder('utf8');
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        note(line);
        send({ o: line });
      }
    });
    child.stderr.on('data', (c) => send({ e: c.toString('utf8') }));
    child.on('error', (e) => { spawnError = e.message; send({ err: e.message }); });
    child.on('close', (code, signal) => {
      exited = [code, signal];
      send({ x: exited });
      leave();
    });
  }

  function resume() {
    if (!paused) return;
    paused = false;
    if (!exited) child.kill('SIGCONT');
    send({ paused: false });
  }

  function stop(signal = 'SIGTERM') {
    if (!child || exited) return;
    resume(); // a stopped process doesn't get the signal until it goes on
    child.kill(signal);
  }

  function onOp(op) {
    if (op.op === 'state') send(stateFrame());
    else if (op.op === 'in') {
      if (op.d.startsWith('{"type":"control_response"')) {
        try { open.delete(JSON.parse(op.d).response?.request_id); } catch {}
      } else if (op.d.startsWith('{"type":"user"')) turn = true;
      if (child?.stdin.writable) child.stdin.write(op.d);
    } else if (op.op === 'end') child?.stdin.end();
    else if (op.op === 'kill') stop(op.signal);
  }

  const server = net.createServer((socket) => {
    if (client) client.destroy();
    client = socket;
    clearTimeout(graceTimer);
    if (!child) start();
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try { onOp(JSON.parse(line)); } catch (e) { console.error(e.message); }
      }
    });
    socket.on('close', () => {
      if (client !== socket) return;
      client = null;
      // No window to come back: claude is stopped; what it does on SIGTERM ends this process.
      graceTimer = setTimeout(() => {
        stop();
        setTimeout(() => stop('SIGKILL'), 5000);
      }, GRACE_MS);
    });
  });
  server.on('error', (e) => { console.error(e.message); process.exit(1); });
  try { fs.unlinkSync(sock); } catch {}
  server.listen(sock, () => {
    try { fs.chmodSync(sock, 0o600); } catch {}
    saveRecord();
  });
  setTimeout(() => { if (!child) leave(); }, FIRST_CLIENT_MS);
  process.on('SIGTERM', () => { if (child && !exited) stop(); else process.exit(0); }); // a paused claude must not stay behind

  async function check() {
    checking = true;
    const ok = (await fullyAwake()) && (await resolves(hostToCheck(env)));
    checking = false;
    nextCheck = Date.now() + CHECK_MS;
    if (ok) resume();
  }

  setInterval(() => {
    const now = Date.now();
    const slept = now - lastTick > SLEPT_AFTER_MS;
    lastTick = now;
    if (!child || exited) return;
    if (slept && !paused && busy()) {
      paused = true;
      waited = 0;
      nextCheck = 0;
      child.kill('SIGSTOP');
      send({ paused: true });
    }
    if (!paused) return;
    if (!slept) waited += TICK_MS;
    if (waited >= WAIT_LIMIT_MS) return resume();
    if (!checking && now >= nextCheck) check();
  }, TICK_MS);
}
