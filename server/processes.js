#!/usr/bin/env node
/**
 * Persistent registry of the processes Claude Code runs on this machine.
 *
 * Tracks every `claude -p` run the server spawns and every other Claude Code process, whoever
 * started it (a terminal, the Claude-AI app, VS Code, the SDK): each running one describes itself
 * in ~/.claude/sessions/<pid>.json (sessionId, cwd, name). Plus everything those processes start
 * (Bash tool commands, background jobs, dev servers, hooks, MCP servers) — entries stay after their
 * claude exits, so processes left behind by a finished session show up and can be stopped. The
 * registry survives restarts of the wrapper. The server's own short control processes (one-shot
 * control requests, cli-control.js) are left out.
 *
 * Attribution (macOS / Linux, via `ps`):
 *   1. Descendants of the server and of registered processes (ppid chain).
 *   2. Members of process groups recorded in the shell journal. The server runs claude with
 *      CLAUDE_CODE_SHELL_PREFIX=track-shell.sh, which logs "pid pgid ppid epoch runId" for every
 *      shell command. Jobs detached with `cmd &` / `nohup cmd &` keep that group after being
 *      reparented to PID 1, so they are recognised even if the shell lived only milliseconds.
 *      Only while the group is ours: a member must have joined while our shell lived (see
 *      groupOpenUntil); group numbers are reused, and a process given a freed number later
 *      belongs to someone else. Entries record how they came (`via`: "tree" or "group"); older
 *      ones first seen long after they started are re-checked and dropped if foreign.
 *   Not covered: a job that creates its own new process group/session AND whose parent exits
 *   before the next scan (e.g. a daemon that double-forks with setsid).
 *
 * PIDs are reused by the OS, so every entry is identified by pid + start time; an entry is
 * "alive" only if a process with the same pid AND the same start time exists.
 *
 * Files (in .run/ next to this script):
 *   processes.json     — the registry (override: CLAUDE_WEB_REGISTRY)
 *   shell-journal.log  — written by track-shell.sh (override: CLAUDE_WEB_JOURNAL)
 *
 * CLI (works without the server):
 *   node processes.js            — live processes
 *   node processes.js --all      — include exited ones
 *   node processes.js --json     — machine-readable output
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Run as a CLI (`node processes.js`): read the same .env as the server; the shell wins.
if (require.main === module) {
  try { process.loadEnvFile(require('./paths').ENV_FILE); } catch {}
}

const { RUN_DIR, fromData } = require('./paths');
// Relative paths in the settings are relative to this folder, not to where the server was started.
const fromSetting = (v, fallback) => (v ? fromData(v) : fallback);
const REGISTRY_FILE = fromSetting(process.env.CLAUDE_WEB_REGISTRY, path.join(RUN_DIR, 'processes.json'));
const JOURNAL_FILE = fromSetting(process.env.CLAUDE_WEB_JOURNAL, path.join(RUN_DIR, 'shell-journal.log'));
const SHELL_PREFIX = path.join(__dirname, 'track-shell.sh');

const SESSIONS_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'), 'sessions');
// cli-control.js oneShot(): `claude -p` with exactly these arguments, no prompt flags.
const CONTROL_RE = /(^|\/)claude -p --input-format stream-json --output-format stream-json --verbose( --resume [\w-]+)?$/;

const KEEP_EXITED_RUN_MS = 7 * 24 * 3600_000; // claude runs and servers
const KEEP_EXITED_OTHER_MS = 3600_000; // everything else
const KEEP_JOURNAL_MS = 7 * 24 * 3600_000;
const JOURNAL_COMPACT_BYTES = 2 * 1024 * 1024;
// Our own scanner, excluded from tracking.
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,%cpu=,rss=,lstart=,command='];

/**
 * One `ps` snapshot: Map<pid, { pid, ppid, pgid, cpu, rss, started, command }> — cpu: % of one
 * core, averaged by the kernel over about the last minute; rss: resident memory in KB.
 */
function snapshot() {
  return new Promise((resolve, reject) => {
    // LC_TIME=C fixes the `lstart` format ("Tue Sep 29 16:56:40 2026"), LC_NUMERIC=C the decimal
    // point of %cpu; UTF-8 LC_CTYPE keeps non-ASCII command lines readable instead of `M-P...` escapes.
    const env = { ...process.env, LC_TIME: 'C', LC_NUMERIC: 'C', LC_CTYPE: 'en_US.UTF-8' };
    delete env.LC_ALL;
    execFile('ps', PS_ARGS, { env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      const procs = new Map();
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        procs.set(pid, {
          pid,
          ppid: Number(m[2]),
          pgid: Number(m[3]),
          cpu: Number(m[4].replace(',', '.')),
          rss: Number(m[5]),
          started: new Date(m[6].replace(/\s+/g, ' ')).toISOString(),
          command: m[7],
        });
      }
      resolve(procs);
    });
  });
}

const keyOf = (pid, started) => `${pid}@${started}`;

/**
 * Claude Code processes that describe themselves in ~/.claude/sessions/<pid>.json and are alive
 * (same pid and start time): Map<pid, { sessionId, cwd, name, kind, entrypoint }>.
 */
function claudeSessions(procs) {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(SESSIONS_DIR); } catch { return out; }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    const p = procs.get(Number(m[1]));
    if (!p) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8')); } catch { continue; }
    // The same process only if its start time matches: procStart is `lstart`-style text in UTC
    // (taken as local time too, to be safe), startedAt the CLI's own start a moment later.
    const at = Date.parse(p.started);
    const text = String(d.procStart || '').replace(/\s+/g, ' ');
    const near = (t, ms) => Number.isFinite(t) && Math.abs(t - at) <= ms;
    if (!near(Date.parse(text + ' UTC'), 1500) && !near(Date.parse(text), 1500) && !near(d.startedAt, 30000)) continue;
    out.set(p.pid, {
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : null,
      cwd: typeof d.cwd === 'string' ? d.cwd : null,
      name: typeof d.name === 'string' ? d.name : null,
      launch: typeof d.entrypoint === 'string' ? d.entrypoint : typeof d.kind === 'string' ? d.kind : null,
    });
  }
  return out;
}

function readRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    // The server is only the root of the process tree — it is started by the user, not by
    // Claude — so it is never an entry (older registries recorded it; drop those).
    return Array.isArray(data.processes) ? data.processes.filter((e) => e.kind !== 'server') : [];
  } catch {
    return [];
  }
}

/**
 * Parses journal lines "pid pgid ppid epoch runId" into Map<pgid, { since, runId }>.
 * Only shells that lead their own group (pid == pgid) count: they created the group, so all its
 * members are ours. A shell that inherited a group (hooks, MCP servers run inside claude's group,
 * which is the server's group, which is whatever launched the server) must not claim it.
 */
function parseJournal(text, into = new Map()) {
  for (const line of text.split('\n')) {
    const [pid, pgid, , epoch, runId] = line.trim().split(/\s+/);
    const g = Number(pgid);
    if (!g || Number(pid) !== g || !Number(epoch)) continue;
    const since = Number(epoch) * 1000;
    const prev = into.get(g);
    // A group id can be reused later; keep the most recent owner.
    if (!prev || prev.since < since) into.set(g, { since, runId: runId && runId !== '-' ? runId : null });
  }
  return into;
}

/** How far the shell's own start may lie from the epoch it wrote to the journal (lstart has 1 s steps). */
const SHELL_START_SLACK_MS = 3000;

/**
 * Whether journalled group `g` still names the group our shell created. PIDs are reused: once the
 * shell (pid == pgid == g) exits, the OS may give the same number to a new process, and a daemon
 * started by launchd/systemd leads its own group, so its pgid is that number too. While a process
 * with pid `g` exists it must therefore be our shell (started when the journal line was written);
 * otherwise the number was reused and nothing in that group is ours. With no process `g` at all,
 * the shell has exited and the remaining members are its detached jobs.
 */
function groupStillOurs(g, entry, procs) {
  const leader = procs.get(g);
  if (!leader) return true;
  return Math.abs(Date.parse(leader.started) - entry.since) <= SHELL_START_SLACK_MS;
}

/** How long after our shell was last seen alive a member may still have joined (scans every 1-5 s). */
const GROUP_OPEN_SLACK_MS = 10_000;

/**
 * Until when journalled group `g` could get members of ours. A process joins a group when it is
 * created inside it, so our members appear while our shell (pid g) runs — `cmd &` included — and
 * afterwards only as children of members, which the walk over descendants follows anyway. A
 * process that turns up in the group later is another group that reused the number: macOS gives
 * a freed id to a new process, which may lead a new group and exit, leaving members with that
 * pgid and no leader (seen: a `bun --watch` started elsewhere a day after our shell, picked up
 * when the server re-read the journal). The shell's last sight: `entry.seenAlive` (set by scans),
 * else its own registry entry, else it lived less than a scan and the journal time stands.
 */
function groupOpenUntil(g, entry, entries) {
  if (entry.seenAlive == null && !entry.shellLookedUp) {
    entry.shellLookedUp = true; // once: later sightings come from the scans
    for (const e of entries) {
      if (e.pid === g && Math.abs(Date.parse(e.started) - entry.since) <= SHELL_START_SLACK_MS) {
        entry.seenAlive = Date.parse(e.exited || e.lastSeen || e.started);
        break;
      }
    }
  }
  return (entry.seenAlive ?? entry.since) + GROUP_OPEN_SLACK_MS;
}

/** Whether `p` is a member of a journalled group of ours (see groupStillOurs, groupOpenUntil). */
function inOurGroup(p, groups, entries, procs) {
  const g = groups.get(p.pgid);
  if (!g || !groupStillOurs(p.pgid, g, procs)) return false;
  const started = Date.parse(p.started);
  if (started < g.since - 2000) return false;
  return procs.has(p.pgid) || started <= groupOpenUntil(p.pgid, g, entries); // our shell still runs, or joined in time
}

/** A child entry first seen this long after it started was picked up late (after a restart). */
const LATE_FIRST_SEEN_MS = 5 * 60_000;

/**
 * Whether entry `e` may have been recorded through a group number that wasn't ours. Entries say
 * how they came (`via`: "tree" through an ancestor that was ours — kept even after it exits,
 * "group" through a group checked as ours at the time). Older ones don't: those seen while young
 * came through an ancestor; those first seen long after they started came through a journalled
 * group after a server restart — every misattributed entry found so far was such a one.
 */
function suspect(e) {
  return e.kind === 'child' && !e.exited && !e.via && Date.parse(e.firstSeen) - Date.parse(e.started) > LATE_FIRST_SEEN_MS;
}

/**
 * Whether live process `p` is traceably ours: true if its ancestry reaches the server or a live
 * claude run, or a member that joined a journalled group of ours in time; false if it is in a
 * journalled group without that (a reused number) or descends from such a process; null if it is
 * an orphan outside the journalled groups (e.g. an MCP server left by an exited run), which only
 * its registry entry can tell.
 */
function traceOwnership(p, { groups, entries, procs, serverPid, runPids, memo = new Map() }) {
  if (memo.has(p.pid)) return memo.get(p.pid);
  memo.set(p.pid, null); // a cycle (pid reuse between scans) ends here
  let r;
  if (p.pid === serverPid || runPids.has(p.pid)) r = true;
  else {
    const parent = p.ppid > 1 ? procs.get(p.ppid) : null;
    const up = parent ? traceOwnership(parent, { groups, entries, procs, serverPid, runPids, memo }) : null;
    r = up === true ? true : groups.has(p.pgid) ? inOurGroup(p, groups, entries, procs) : up;
  }
  memo.set(p.pid, r);
  return r;
}

class ProcessRegistry {
  constructor({ serverPid = process.pid, activeIntervalMs = 1000, idleIntervalMs = 5000 } = {}) {
    this.serverPid = serverPid;
    this.activeIntervalMs = activeIntervalMs;
    this.idleIntervalMs = idleIntervalMs;
    /** key -> entry; entries from previous server instances are kept. */
    this.entries = new Map(readRegistry().map((e) => [keyOf(e.pid, e.started), e]));
    /** Processes seen once; registered only if still alive on the next scan. */
    this.pending = new Map();
    /** pgid -> { since, runId } from the shell journal. */
    this.groups = new Map();
    this.journalOffset = 0;
    this.activeRuns = 0;
    this.liveClaude = 0; // live Claude Code processes of any origin (frequent scans while there are some)
    this.saveTimer = null;
    this.scanTimer = null;
    this.scanning = null;
  }

  /** Env for a claude run so that its shells report their process groups. */
  childEnv(runId) {
    const env = {
      ...process.env,
      CLAUDE_CODE_SHELL_PREFIX: SHELL_PREFIX,
      CLAUDE_WEB_JOURNAL: JOURNAL_FILE,
      CLAUDE_WEB_RUN_ID: runId,
    };
    const orig = process.env.CLAUDE_CODE_SHELL_PREFIX;
    if (orig && orig !== SHELL_PREFIX) env.CLAUDE_WEB_ORIG_PREFIX = orig;
    return env;
  }

  /** Starts periodic scanning; scans often while a claude run is active. */
  start() {
    fs.mkdirSync(path.dirname(JOURNAL_FILE), { recursive: true });
    // CLAUDE_CODE_SHELL_PREFIX must be executable; an unpacked copy may have lost the bit.
    try { fs.accessSync(SHELL_PREFIX, fs.constants.X_OK); } catch { try { fs.chmodSync(SHELL_PREFIX, 0o755); } catch {} }
    const tick = async () => {
      await this.scan().catch((e) => console.error('[processes] scan failed:', e.message));
      this.scanTimer = setTimeout(tick, this.activeRuns > 0 || this.liveClaude > 0 ? this.activeIntervalMs : this.idleIntervalMs);
      this.scanTimer.unref?.();
    };
    tick();
  }

  stop() {
    clearTimeout(this.scanTimer);
    this.flush();
  }

  /** Registers a process we spawned directly (server, claude run). */
  async register(pid, meta = {}) {
    const proc = (await snapshot()).get(pid);
    if (!proc) return null;
    const key = keyOf(pid, proc.started);
    const prev = this.entries.get(key);
    const now = new Date().toISOString();
    const entry = { ...prev, ...this.fromProc(proc), ...meta, firstSeen: prev?.firstSeen || now, lastSeen: now, exited: null };
    this.entries.set(key, entry);
    this.pending.delete(pid);
    if (meta.kind === 'claude') this.activeRuns++;
    this.save();
    return entry;
  }

  /** Adds metadata (e.g. sessionId) to a live registered process. */
  annotate(pid, meta) {
    for (const e of this.entries.values()) if (e.pid === pid && !e.exited) Object.assign(e, meta);
    this.save();
  }

  /** Called from the claude child's `close` event. */
  runFinished() {
    this.activeRuns = Math.max(0, this.activeRuns - 1);
    this.scan().catch(() => {});
  }

  fromProc(p) {
    return { pid: p.pid, ppid: p.ppid, pgid: p.pgid, cpu: p.cpu, rss: p.rss, started: p.started, command: p.command.slice(0, 500) };
  }

  /** Reads journal lines appended since the last call; compacts the file when it grows. */
  readJournal() {
    let st;
    try {
      st = fs.statSync(JOURNAL_FILE);
    } catch {
      return;
    }
    if (st.size < this.journalOffset) this.journalOffset = 0; // truncated or replaced
    if (st.size === this.journalOffset) return;
    const fd = fs.openSync(JOURNAL_FILE, 'r');
    try {
      const buf = Buffer.alloc(st.size - this.journalOffset);
      fs.readSync(fd, buf, 0, buf.length, this.journalOffset);
      const text = buf.toString('utf8');
      const complete = text.slice(0, text.lastIndexOf('\n') + 1); // leave a partial last line
      this.journalOffset += Buffer.byteLength(complete);
      parseJournal(complete, this.groups);
    } finally {
      fs.closeSync(fd);
    }
    if (st.size > JOURNAL_COMPACT_BYTES) this.compactJournal();
  }

  /** Drops journal lines older than KEEP_JOURNAL_MS. */
  compactJournal() {
    const cutoff = Date.now() - KEEP_JOURNAL_MS;
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n')
      .filter((l) => Number(l.split(' ')[3]) * 1000 >= cutoff);
    const tmp = JOURNAL_FILE + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n') + '\n');
    fs.renameSync(tmp, JOURNAL_FILE);
    this.journalOffset = fs.statSync(JOURNAL_FILE).size;
    for (const [g, v] of this.groups) if (v.since < cutoff) this.groups.delete(g);
  }

  /** Re-reads the process table: records new processes of ours, marks exited ones. */
  scan() {
    if (this.scanning) return this.scanning; // serialise; overlapping scans race on `entries`
    this.scanning = this.doScan().finally(() => (this.scanning = null));
    return this.scanning;
  }

  /** The server's own one-shot control process (cli-control.js): not a run, not listed. */
  isControl(p) {
    return CONTROL_RE.test(p.command);
  }

  isScanner(p) {
    return p.ppid === process.pid && p.command.startsWith('ps ' + PS_ARGS.join(' '));
  }

  /** True if `p` joined a journalled process group of ours while that group was ours. */
  inJournalGroup(p, procs) {
    return inOurGroup(p, this.groups, this.entries.values(), procs);
  }

  /**
   * Drops live child entries recorded through a journalled group that can't be ours (see
   * traceOwnership) — by the registry before the join-time check existed, or through such a
   * process's descendants. Orphans outside the journalled groups keep their entries.
   */
  dropForeign(procs) {
    if (![...this.entries.values()].some(suspect)) return 0;
    const runPids = new Set();
    for (const e of this.entries.values()) {
      const p = procs.get(e.pid);
      if (e.kind === 'claude' && p && p.started === e.started) runPids.add(e.pid);
    }
    const ctx = { groups: this.groups, entries: [...this.entries.values()], procs, serverPid: this.serverPid, runPids, memo: new Map() };
    let dropped = 0;
    for (const [key, e] of this.entries) {
      const p = procs.get(e.pid);
      if (!suspect(e) || !p || p.started !== e.started) continue;
      if (traceOwnership(p, ctx) === false) {
        this.entries.delete(key);
        dropped++;
      }
    }
    return dropped;
  }

  /**
   * Forgets journalled groups that can no longer be ours: the number was reused by another
   * process (see `groupStillOurs`), or no member is alive any more — after that the number is
   * free, and a later process given it must not inherit the attribution. Returns the reused ids.
   */
  retireGroups(procs) {
    const live = new Set();
    for (const p of procs.values()) live.add(p.pgid);
    const reused = new Set();
    for (const [g, entry] of this.groups) {
      if (!groupStillOurs(g, entry, procs)) {
        reused.add(g);
        this.groups.delete(g);
      } else if (!live.has(g)) {
        this.groups.delete(g);
      } else if (procs.has(g)) {
        entry.seenAlive = Date.now(); // our shell is running: the group still takes members
      }
    }
    return reused;
  }

  async doScan() {
    this.readJournal();
    const procs = await snapshot();
    const now = new Date().toISOString();
    let changed = false;

    // A reused group id once made system daemons (reparented to PID 1, leading their own group)
    // look like ours. Retire such groups and drop the entries recorded through them.
    const reused = this.retireGroups(procs);
    for (const [key, e] of this.entries) {
      if (e.kind === 'child' && !e.exited && e.ppid === 1 && e.pid === e.pgid && reused.has(e.pgid)) {
        this.entries.delete(key);
        changed = true;
      }
    }
    // Likewise processes that joined a journalled group's number after our shell was gone.
    if (this.dropForeign(procs)) changed = true;

    // Every Claude Code process, whoever started it: registered (or refreshed) from its session
    // file; its descendants then come in through `tree` below. A run of ours keeps its runId.
    const sessionProcs = claudeSessions(procs);
    this.liveClaude = sessionProcs.size;
    for (const [pid, info] of sessionProcs) {
      const p = procs.get(pid);
      if (this.isControl(p)) continue;
      const key = keyOf(pid, p.started);
      const e = this.entries.get(key);
      if (e) {
        const upd = { sessionId: info.sessionId || e.sessionId || null, cwd: e.cwd || info.cwd, name: info.name || e.name || null, launch: e.launch || info.launch };
        if (Object.entries(upd).some(([k, v]) => e[k] !== v)) { Object.assign(e, upd); changed = true; }
        if (e.kind !== 'claude') { e.kind = 'claude'; changed = true; }
        if (!e.runId) { e.runId = `cli-${pid}-${Date.parse(p.started)}`; changed = true; }
        continue;
      }
      this.entries.set(key, {
        ...this.fromProc(p), kind: 'claude', via: 'session', runId: `cli-${pid}-${Date.parse(p.started)}`,
        sessionId: info.sessionId, cwd: info.cwd, name: info.name, launch: info.launch,
        parentRun: null, firstSeen: now, lastSeen: now, exited: null,
      });
      changed = true;
    }

    const children = new Map();
    for (const p of procs.values()) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p);
    }

    const closeOver = (set) => {
      const queue = [...set];
      while (queue.length) {
        for (const c of children.get(queue.pop()) || []) {
          if (!set.has(c.pid)) { set.add(c.pid); queue.push(c.pid); }
        }
      }
      return set;
    };
    // `tree`: the server, live registered processes and their descendants — a new entry found
    // here is ours through an ancestor that was (via "tree"), and stays so after that ancestor
    // exits. Then members of journalled groups of ours and their descendants (via "group").
    const tree = new Set();
    if (procs.has(this.serverPid)) tree.add(this.serverPid);
    for (const e of this.entries.values()) {
      const p = procs.get(e.pid);
      if (p && p.started === e.started) tree.add(e.pid);
    }
    closeOver(tree);
    const ours = new Set(tree);
    for (const p of procs.values()) if (!ours.has(p.pid) && this.inJournalGroup(p, procs)) ours.add(p.pid);
    closeOver(ours);

    // New processes go to `pending` first and are registered if still alive on the next scan,
    // so the registry isn't flooded with commands that lived a few milliseconds.
    const seenPending = new Map();
    for (const pid of ours) {
      const p = procs.get(pid);
      if (!p || pid === this.serverPid || this.isScanner(p) || this.isControl(p)) continue;
      const key = keyOf(p.pid, p.started);
      const existing = this.entries.get(key);
      if (existing) {
        Object.assign(existing, { lastSeen: now, ppid: p.ppid, cpu: p.cpu, rss: p.rss });
        continue;
      }
      const kind = this.classify(p);
      const firstSeen = this.pending.get(key) || now;
      if (this.pending.has(key) || kind === 'claude' || kind === 'server') {
        const via = tree.has(pid) ? 'tree' : 'group';
        this.entries.set(key, { ...this.fromProc(p), kind, via, parentRun: this.findRun(p, procs), firstSeen, lastSeen: now, exited: null });
        changed = true;
      } else {
        seenPending.set(key, firstSeen);
      }
    }
    this.pending = seenPending;

    // Mark exited; prune old exited entries.
    const nowMs = Date.now();
    for (const [key, e] of this.entries) {
      const p = procs.get(e.pid);
      const alive = !!p && p.started === e.started;
      if (!alive && !e.exited) {
        e.exited = e.lastSeen || now;
        changed = true;
      }
      if (e.exited) {
        const keep = e.kind === 'claude' || e.kind === 'server' ? KEEP_EXITED_RUN_MS : KEEP_EXITED_OTHER_MS;
        if (nowMs - Date.parse(e.exited) > keep) {
          this.entries.delete(key);
          changed = true;
        }
      }
    }

    if (changed) this.save();
  }

  classify(p) {
    if (p.pid === this.serverPid) return 'server';
    if (/mcp-permission\.js/.test(p.command)) return 'bridge';
    if (/(^|\/)claude\s/.test(p.command) && /\s-p\s/.test(p.command)) return 'claude';
    return 'child';
  }

  /** The claude run that started `p`: via the ppid chain, or via the journalled group's runId. */
  findRun(p, procs) {
    const runs = [...this.entries.values()].filter((e) => e.kind === 'claude');
    const byPid = new Map(runs.filter((r) => !r.exited).map((r) => [r.pid, r]));
    for (let cur = p, i = 0; cur && i < 64; i++) {
      const r = byPid.get(cur.ppid);
      if (r) return { pid: r.pid, runId: r.runId || null, sessionId: r.sessionId || null };
      cur = procs.get(cur.ppid);
    }
    const g = this.inJournalGroup(p, procs) && this.groups.get(p.pgid);
    if (g && g.runId) {
      const r = runs.find((x) => x.runId === g.runId);
      return { pid: r?.pid || null, runId: g.runId, sessionId: r?.sessionId || null };
    }
    return null;
  }

  /** Entries, newest first; exited ones only on request. */
  list({ includeExited = false } = {}) {
    return [...this.entries.values()]
      .filter((e) => (includeExited || !e.exited) && !CONTROL_RE.test(e.command))
      .map((e) => {
        // Session of the run may have become known after the child was registered.
        if (e.parentRun && !e.parentRun.sessionId) {
          const r = [...this.entries.values()].find((x) => x.kind === 'claude' && x.runId && x.runId === e.parentRun.runId);
          if (r?.sessionId) e.parentRun.sessionId = r.sessionId;
        }
        return e;
      })
      .sort((a, b) => b.started.localeCompare(a.started));
  }

  /**
   * Signals a registered live process (and, with `tree`, its descendants).
   * Refuses PIDs that are not in the registry or whose start time no longer matches.
   */
  async kill(pid, { signal = 'SIGTERM', tree = true } = {}) {
    const procs = await snapshot();
    const p = procs.get(pid);
    const entry = [...this.entries.values()].find((e) => e.pid === pid && !e.exited && p && e.started === p.started);
    if (!entry) throw new Error('The process is not among the ones the wrapper started');
    if (pid === this.serverPid || pid === process.pid) throw new Error('The wrapper server can’t be stopped from here');

    const targets = [pid];
    if (tree) {
      const children = new Map();
      for (const q of procs.values()) {
        if (!children.has(q.ppid)) children.set(q.ppid, []);
        children.get(q.ppid).push(q.pid);
      }
      for (let i = 0; i < targets.length; i++) targets.push(...(children.get(targets[i]) || []));
    }
    const killed = [];
    for (const t of targets.reverse()) { // children first, so parents can't respawn them
      try {
        process.kill(t, signal);
        killed.push(t);
      } catch {
        // already gone
      }
    }
    setTimeout(() => this.scan().catch(() => {}), 300);
    return killed;
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 200);
    this.saveTimer.unref?.();
  }

  /** Atomic write (temp file + rename): a crash never leaves a half-written registry. */
  flush() {
    clearTimeout(this.saveTimer);
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    const tmp = `${REGISTRY_FILE}.${process.pid}.tmp`;
    const data = { updated: new Date().toISOString(), serverPid: this.serverPid, processes: [...this.entries.values()] };
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, REGISTRY_FILE);
  }
}

/**
 * Registry checked against the live process table, without a running server. Also reports
 * orphans in journalled groups that the server never got to record (e.g. it was down).
 */
async function checkRegistry() {
  const procs = await snapshot();
  let groups = new Map();
  try { groups = parseJournal(fs.readFileSync(JOURNAL_FILE, 'utf8')); } catch {}
  let serverPid = null;
  try { serverPid = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')).serverPid; } catch {}
  const entries = readRegistry();
  const reusedGroup = (pgid) => groups.has(pgid) && !groupStillOurs(pgid, groups.get(pgid), procs);
  const runPids = new Set(entries.filter((e) => e.kind === 'claude' && procs.get(e.pid)?.started === e.started).map((e) => e.pid));
  const ctx = { groups, entries, procs, serverPid, runPids, memo: new Map() };
  const rows = entries
    .map((e) => {
      const p = procs.get(e.pid);
      return { ...e, alive: !!p && p.started === e.started };
    })
    // Recorded before the reuse checks existed: a daemon that took a journalled group's number,
    // or a process that joined one after our shell was gone (see traceOwnership).
    .filter((e) => !(e.kind === 'child' && e.alive && e.ppid === 1 && e.pid === e.pgid && reusedGroup(e.pgid)))
    .filter((e) => !(e.alive && suspect(e) && traceOwnership(procs.get(e.pid), ctx) === false));
  const known = new Set(rows.map((r) => keyOf(r.pid, r.started)));
  // Don't report this CLI itself: when run from a Claude Bash command, its shell group is journalled.
  const ownGroup = procs.get(process.pid)?.pgid;
  for (const p of procs.values()) {
    const g = groups.get(p.pgid);
    if (!g || p.pgid === ownGroup || known.has(keyOf(p.pid, p.started))) continue;
    if (!inOurGroup(p, groups, entries, procs)) continue;
    rows.push({
      pid: p.pid, ppid: p.ppid, pgid: p.pgid, started: p.started, command: p.command.slice(0, 500),
      kind: 'child', parentRun: g.runId ? { runId: g.runId } : null, alive: true, unrecorded: true,
    });
  }
  return rows;
}

module.exports = { ProcessRegistry, checkRegistry, REGISTRY_FILE, JOURNAL_FILE };

// CLI: inspect the registry even when the server is down.
if (require.main === module) {
  (async () => {
    const all = process.argv.includes('--all');
    const rows = (await checkRegistry())
      .filter((e) => all || e.alive)
      .sort((a, b) => b.started.localeCompare(a.started));
    if (process.argv.includes('--json')) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) console.log(all ? 'Registry is empty.' : 'No live processes started by the wrapper.');
    for (const e of rows) {
      const state = e.alive ? 'alive ' : 'exited';
      const run = e.parentRun ? ` run=${e.parentRun.pid || e.parentRun.runId?.slice(0, 8)}` : '';
      const session = e.sessionId || e.parentRun?.sessionId;
      console.log(
        `${String(e.pid).padStart(6)}  ${state}  ${e.kind.padEnd(6)}  started ${e.started}${run}` +
          (session ? ` session=${session.slice(0, 8)}` : '') + (e.unrecorded ? '  (not in registry yet)' : '') +
          `\n        ${e.command.slice(0, 160)}`,
      );
    }
    console.log(`\nRegistry: ${REGISTRY_FILE}`);
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
