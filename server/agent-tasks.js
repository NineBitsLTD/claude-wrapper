'use strict';
/**
 * Subagents of the chat runs (Agent tool, workflows, teammates) for the side panel's agent list,
 * built like the VS Code extension's agent map.
 *
 * A subagent has no OS process of its own: it works inside its run's claude process, so the
 * process registry can't see it. The server passes every run's stdout events here:
 * - system task_* events (task_started, task_progress, task_updated, task_notification) of agent
 *   tasks make the entries; nesting comes from parent_task_id;
 * - the subagent's own messages, which the CLI forwards with parent_tool_use_id = the Agent call
 *   that started it (tool calls only; text stays unsent), give its model and its recent steps;
 * - the Agent call's input gives the requested model until the served one is known;
 * - the end of a run ends whatever of it was still running.
 * spendOf(entry) adds up what an agent really used: the usage of each of its API calls in its
 * transcript (<session>/subagents/agent-<id>.jsonl, an internal format), read on from where the
 * last read stopped. The CLI's own usage.total_tokens is something else: the context of the
 * agent's latest request plus all its output.
 * Finished agents stay listed for KEEP_DONE_MS (at most MAX_DONE of them). In memory only: agents
 * end with their process anyway.
 *
 * list({ cwd, all }) -> entries, newest first: { id, runId, sessionId, cwd, runPrompt, kind,
 * agent, workflow, description, prompt, toolUseId, parentId, depth, background, started, ended,
 * status, model, messages, steps: [{ name, detail }], usage, lastTool, activity, result, error,
 * spend: { requests, input, cacheWrite, cacheRead, output } once spendOf() found the transcript }.
 */
const fsp = require('fs/promises');
const { StringDecoder } = require('string_decoder');
const sessions = require('./sessions');

const KINDS = new Set(['local_agent', 'remote_agent', 'local_workflow', 'in_process_teammate']);
const DONE = new Set(['completed', 'failed', 'killed', 'stopped']);
const KEEP_DONE_MS = 60 * 60_000;
const MAX_DONE = 100;
const MAX_TEXT = 4000;
const MAX_STEPS = 30;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

const agents = new Map();      // task_id -> entry
const byToolUse = new Map();   // tool_use_id of the Agent call -> task_id
const callInputs = new Map();  // tool_use_id of an Agent call -> its input, until task_started
const tails = new Map();       // task_id -> reading position in its transcript (spendOf)
const CHUNK = 4 * 1024 * 1024;
const cut = (s, max = MAX_TEXT) => (typeof s === 'string' && s.length > max ? s.slice(0, max) + '…' : s || '');

/** A tool call in a word: its command, file, pattern or address. */
function stepDetail(input = {}) {
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || input.prompt || '';
  return cut(String(v).replace(/\s+/g, ' ').trim(), 120);
}

/** Messages of the agents themselves (forwarded with parent_tool_use_id) and Agent calls. */
function onMessage(ev) {
  const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
      callInputs.set(b.id, b.input || {});
      if (callInputs.size > 200) callInputs.delete(callInputs.keys().next().value);
    }
  }
  const a = ev.parent_tool_use_id && agents.get(byToolUse.get(ev.parent_tool_use_id));
  if (!a || ev.type !== 'assistant') return;
  if (ev.message?.model) a.model = ev.message.model;
  a.messages++;
  for (const b of blocks) {
    if (b.type !== 'tool_use') continue;
    a.steps.push({ name: b.name, detail: stepDetail(b.input) });
    if (a.steps.length > MAX_STEPS) a.steps.shift();
  }
}

/** One stdout event of run `runId` ({ sessionId, cwd, prompt }). */
function onEvent(runId, run, ev) {
  if (ev.type === 'assistant' || ev.type === 'user') return onMessage(ev);
  if (ev.type !== 'system' || !ev.task_id || !/^task_/.test(ev.subtype || '')) return;
  let a = agents.get(ev.task_id);
  if (ev.subtype === 'task_started') {
    if (!KINDS.has(ev.task_type)) return;
    a = {
      id: ev.task_id, runId, sessionId: run.sessionId, cwd: run.cwd, runPrompt: run.prompt || '',
      kind: ev.task_type, agent: ev.subagent_type || '', workflow: ev.workflow_name || '',
      description: ev.description || '', prompt: cut(ev.prompt), toolUseId: ev.tool_use_id || null,
      parentId: ev.parent_task_id || null, depth: ev.spawn_depth || 1, background: !!ev.is_backgrounded,
      started: Date.now(), ended: null, status: 'running', model: callInputs.get(ev.tool_use_id)?.model || '', messages: 0, steps: [],
      usage: null, lastTool: '', activity: '', result: '', error: '',
    };
    agents.set(a.id, a);
    if (a.toolUseId) { byToolUse.set(a.toolUseId, a.id); callInputs.delete(a.toolUseId); }
    return;
  }
  if (!a) return;
  if (ev.subtype === 'task_progress') {
    if (ev.usage) a.usage = ev.usage;
    if (ev.last_tool_name) a.lastTool = ev.last_tool_name;
    if (ev.summary) a.activity = ev.summary;
  } else if (ev.subtype === 'task_updated') {
    const p = ev.patch || {};
    if (p.status) a.status = p.status;
    if (p.is_backgrounded != null) a.background = p.is_backgrounded;
    if (p.error) a.error = cut(p.error);
  } else if (ev.subtype === 'task_notification') {
    a.status = ev.status || 'completed';
    if (ev.usage) a.usage = ev.usage;
    if (ev.summary) a.result = cut(ev.summary);
  }
  if (DONE.has(a.status) && !a.ended) a.ended = Date.now();
}

/** The run's process is gone: its agents are gone with it. */
function onRunEnd(runId) {
  for (const a of agents.values()) {
    if (a.runId !== runId || a.ended) continue;
    a.status = 'killed';
    a.ended = Date.now();
  }
  prune();
}

function prune() {
  const done = [...agents.values()].filter((a) => a.ended).sort((x, y) => y.ended - x.ended);
  done.forEach((a, i) => {
    if (i < MAX_DONE && Date.now() - a.ended <= KEEP_DONE_MS) return;
    agents.delete(a.id);
    tails.delete(a.id);
    if (a.toolUseId) byToolUse.delete(a.toolUseId);
  });
}

/** What the agent used, summed over its API calls (last usage per message id); null until known. */
async function spendOf(a) {
  let t = tails.get(a.id);
  if (!t) tails.set(a.id, t = { file: null, offset: 0, rest: '', decoder: new StringDecoder('utf8'), byMessage: new Map(), final: false });
  if (t.final) return a.spend;
  t.file ??= await sessions.subagentFile(a.sessionId, a.id);
  if (!t.file) return null;
  let fh;
  try {
    fh = await fsp.open(t.file, 'r');
    const { size } = await fh.stat();
    while (t.offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - t.offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, t.offset);
      if (!bytesRead) break;
      t.offset += bytesRead;
      const lines = (t.rest + t.decoder.write(buf.subarray(0, bytesRead))).split('\n');
      t.rest = lines.pop();
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        // A message's content blocks are separate entries: the last one carries its final usage.
        if (e.type === 'assistant' && e.message?.id && e.message.usage) t.byMessage.set(e.message.id, e.message.usage);
      }
    }
  } catch {
    return a.spend || null;
  } finally {
    await fh?.close();
  }
  const s = { requests: t.byMessage.size, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const u of t.byMessage.values()) {
    s.input += u.input_tokens || 0;
    s.cacheWrite += u.cache_creation_input_tokens || 0;
    s.cacheRead += u.cache_read_input_tokens || 0;
    s.output += u.output_tokens || 0;
  }
  a.spend = s;
  if (a.ended && Date.now() - a.ended > 5000) t.final = true; // its transcript is complete
  return s;
}

/** Running agents (and finished ones with `all`), of one project folder when `cwd` is given. */
function list({ cwd = null, all = false } = {}) {
  prune();
  return [...agents.values()]
    .filter((a) => (!cwd || a.cwd === cwd) && (all || !a.ended))
    .sort((x, y) => y.started - x.started);
}

module.exports = { onEvent, onRunEnd, list, spendOf };
