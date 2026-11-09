'use strict';
/**
 * A claude process that lives outside this process (server/run-holder.js holds it), with the
 * surface of a ChildProcess that server.js uses: pid, exitCode, stdin.write/end/writable, stdout and
 * stderr 'data', kill(), 'error' and 'close'. Besides: `held`; 'paused' (true | false: the machine
 * slept, see run-holder.js); state(cb) for what a page or a host coming back needs; flow(), which
 * lets the frames go once the listeners are in place; disconnect(), which leaves the run working.
 *
 *   const child = await spawn({ bin, args, cwd, env, runId, sessionId, prompt });
 *   const { child, state } = await connect(record);   // a run of a window that was reloaded
 *   records()                                         // the runs held now, of any window
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn: spawnProcess } = require('child_process');
const { RUN_DIR } = require('./paths');

const DIR = path.join(RUN_DIR, 'holders');
const HOLDER = path.join(__dirname, 'run-holder.js');
const DIAL_MS = 8000;

class HeldChild extends EventEmitter {
  /** `adopting`: what comes before the first state is already part of it. */
  constructor(record, socket, { adopting = false } = {}) {
    super();
    this.held = true;
    this.pid = record.claude || null;
    this.exitCode = null;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = {
      writable: true,
      on() {},
      write: (d) => this.op({ op: 'in', d }),
      end: () => { this.stdin.writable = false; this.op({ op: 'end' }); },
    };
    this.socket = socket;
    this.left = false;
    this.flowing = false;
    this.frames = [];
    this.skipping = adopting;
    this.stateWaits = [];
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        this.onFrame(frame);
      }
    });
    socket.on('close', () => { if (!this.left) this.ended(1, null); }); // the holder is gone
  }

  op(o) {
    if (this.socket.destroyed) return false;
    return this.socket.write(JSON.stringify(o) + '\n');
  }

  onFrame(f) {
    if (f.state) {
      this.skipping = false;
      this.pid = f.state.pid || this.pid;
      this.stateWaits.shift()?.(f.state);
    } else if (!this.skipping) {
      if (this.flowing) this.deliver(f);
      else this.frames.push(f);
    }
  }

  deliver(f) {
    if (f.o !== undefined) this.stdout.emit('data', f.o + '\n');
    else if (f.e !== undefined) this.stderr.emit('data', f.e);
    else if (f.err !== undefined) this.emit('error', new Error(f.err));
    else if (f.x) this.ended(f.x[0], f.x[1]);
    else if (f.paused !== undefined) this.emit('paused', f.paused);
  }

  ended(code, signal) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 128;
    this.stdin.writable = false;
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
    this.left = true;
    this.socket.destroy();
  }

  /** The listeners are in place: what has come meanwhile, and what comes next, goes to them. */
  flow() {
    this.flowing = true;
    for (const f of this.frames.splice(0)) this.deliver(f);
  }

  /** `cb(state)` runs right at the frame, so nothing that comes after it can come before. */
  state(cb) {
    this.stateWaits.push(cb);
    this.op({ op: 'state' });
  }

  kill(signal = 'SIGTERM') {
    return this.op({ op: 'kill', signal });
  }

  /** This process goes away; the run doesn't. */
  disconnect() {
    this.left = true;
    this.socket.end();
  }
}

function dial(sock, untilMs) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(sock);
      socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
      socket.once('error', (e) => {
        if (Date.now() >= untilMs) return reject(e);
        setTimeout(attempt, 40);
      });
    };
    attempt();
  });
}

/** Starts a holder and claude in it; resolves when it runs. Rejects if the holder can't start. */
async function spawn({ bin, args, cwd, env, runId, sessionId, prompt }) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  // A socket's path has to be short (about 100 bytes): the data dir's is too long.
  const sock = path.join(os.tmpdir(), `cw-${runId.slice(0, 13)}.sock`);
  const recordFile = path.join(DIR, `${runId}.json`);
  const logFile = path.join(DIR, `${runId}.log`);
  const log = fs.openSync(logFile, 'a', 0o600);
  // process.execPath is VS Code's Electron in the extension host: it has to be told to be Node.
  const holder = spawnProcess(process.execPath, [HOLDER], {
    detached: true,
    stdio: ['pipe', log, log],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ELECTRON_RUN_AS_NODE: '1' },
  });
  fs.closeSync(log);
  const failed = new Promise((_, reject) => holder.once('error', reject));
  holder.stdin.on('error', () => {});
  holder.stdin.end(JSON.stringify({ bin, args, cwd, env, sock, recordFile, logFile, runId, sessionId, prompt }));
  holder.unref();
  const socket = await Promise.race([dial(sock, Date.now() + DIAL_MS), failed]);
  const child = new HeldChild({}, socket);
  await new Promise((resolve) => child.state(resolve));
  return child;
}

/** The runs held now, of any window. */
function records() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'))); } catch {}
  }
  return out;
}

/** Takes over a held run; resolves to { child, state }. A record whose holder is gone is removed. */
async function connect(record) {
  let socket;
  try {
    socket = await dial(record.sock, 0);
  } catch (e) {
    for (const ext of ['json', 'log']) { try { fs.unlinkSync(path.join(DIR, `${record.runId}.${ext}`)); } catch {} }
    throw e;
  }
  const child = new HeldChild(record, socket, { adopting: true });
  const state = await new Promise((resolve) => child.state(resolve));
  if (state.exited) {
    child.disconnect();
    throw new Error('The Claude process has ended');
  }
  return { child, state };
}

module.exports = { spawn, connect, records };
