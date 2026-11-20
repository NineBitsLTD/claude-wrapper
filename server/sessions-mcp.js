'use strict';
/**
 * An MCP server (stdio, newline-delimited JSON-RPC) the wrapper gives its chats' Claude: the earlier
 * sessions of the project — what was said, decided and tried before, also before a compaction of
 * the session at hand — through the index the History's search keeps (session-index.js).
 *
 * claude starts it from the run's --mcp-config (server.js historyMcp): Node — in VS Code its
 * Electron as Node — with `--cwd <project folder>`; NINEBITS_DATA_DIR points to the wrapper's data,
 * so the index is the History's. Its tools only read, and the run allows them (--allowedTools).
 *   search_past_sessions { query, alternatives?, all_projects? }  the best places, with their ids
 *   read_past_session { session_id, uuid?, before?, after? }      the messages around a place
 * Nothing goes to stdout but the protocol: logs go to stderr.
 */
const readline = require('readline');
const sessions = require('./sessions');
const sessionIndex = require('./session-index');

const VERSION = (() => { try { return require('../package.json').version; } catch { return '0'; } })();
const PROTOCOL = '2025-06-18';
const PROJECT = (() => { const i = process.argv.indexOf('--cwd'); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd(); })();
const MESSAGE_MAX = 4000; // characters of one message read back
const READ_MAX = 40000; // characters of one reading in all
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;

const INSTRUCTIONS = 'The earlier Claude Code sessions of this project, searchable: the user\'s messages, your answers and ' +
  'thinking, the summaries of compactions and the tool calls (not their output). Use search_past_sessions when the user ' +
  'refers to earlier work ("как мы это делали", "why did we drop…"), when you need details from before a compaction of ' +
  'this session, or before redoing something that may have been tried; then read_past_session around a found place. ' +
  'The search is literal (every word has to be there, a long word in any form). Thinking is in English while the user ' +
  'may write in another language: give the words in both (alternatives).';

const TOOLS = [
  {
    name: 'search_past_sessions',
    description: 'Search the earlier Claude Code sessions of this project (or of every project) for what was said, decided or ' +
      'tried: the user\'s messages, your answers and thinking, compaction summaries, tool calls. Returns the best places, ' +
      'session by session, with the ids read_past_session takes. Literal: every word of a query must be in a message; a long ' +
      'word matches any of its endings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The words to find, e.g. "redis queue".' },
        alternatives: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'The same in other words or another language (thinking is in English), searched too: a message matches any of the queries.' },
        all_projects: { type: 'boolean', description: 'Search every project, not only this one.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_past_session',
    description: 'Read the messages of an earlier session around a place search_past_sessions found (its uuid), or its last ' +
      'messages without one. Long messages are cut.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The session\'s id.' },
        uuid: { type: 'string', description: 'The found message\'s uuid.' },
        before: { type: 'integer', minimum: 0, maximum: 30, description: 'Messages before it (8).' },
        after: { type: 'integer', minimum: 0, maximum: 30, description: 'Messages after it (8).' },
      },
      required: ['session_id'],
    },
  },
];

const ROLE = { user: 'User', assistant: 'Claude', thinking: 'Claude (thinking)', tool: 'Tool call', compact: 'Compaction summary' };
const when = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
const cut = (text, max) => (text.length > max ? text.slice(0, max) + ` … (${text.length - max} more characters)` : text);

async function search({ query, alternatives = [], all_projects: all = false }) {
  const queries = [query, ...(Array.isArray(alternatives) ? alternatives : [])].filter((q) => typeof q === 'string' && q.trim());
  if (!queries.length) throw new Error('query is empty');
  const cwdOf = new Map();
  if (all) for (const p of await sessions.listProjects()) cwdOf.set(p.dir, p.cwd);
  else for (const dir of await sessions.projectDirsFor(PROJECT)) cwdOf.set(dir, PROJECT);
  if (!cwdOf.size) return `No sessions of ${PROJECT} yet.`;
  const r = await sessionIndex.search({ dirs: [...cwdOf.keys()], queries, sessionsMax: 10 });
  if (!r.sessions.length) return `Nothing found for ${queries.map((q) => JSON.stringify(q)).join(' or ')}${all ? ' in any project' : ''}.`;
  const out = [`${r.total} matching messages in ${r.sessions.length} sessions; the best places:`];
  for (const s of r.sessions) {
    out.push('', `Session ${s.id} "${s.title}" — ${when(s.updated)}${all && cwdOf.get(s.dir) ? ', ' + cwdOf.get(s.dir) : ''} (${s.count} matches)`);
    for (const h of s.hits) out.push(`  - ${ROLE[h.role] || h.role}, ${when(h.ts)}, uuid ${h.uuid}: ${h.snippet}`);
  }
  out.push('', 'read_past_session { session_id, uuid } reads around a place.');
  return out.join('\n');
}

async function read({ session_id: id, uuid = '', before = 8, after = 8 }) {
  if (!SESSION_ID_RE.test(String(id || ''))) throw new Error('session_id is not a session id');
  const clamp = (n) => Math.max(0, Math.min(30, Number.isInteger(n) ? n : 8));
  const f = await sessionIndex.fragment(id, String(uuid || ''), { before: clamp(before), after: clamp(after) });
  if (!f) throw new Error(`No session ${id}`);
  const out = [`Session ${f.id} "${f.title}"${uuid ? ', around ' + uuid : ', its last messages'}:`];
  let left = READ_MAX;
  for (const [i, m] of f.items.entries()) {
    if (left <= 0) { out.push('', '… (the rest is cut: read again with fewer messages)'); break; }
    const text = cut(m.text, Math.min(MESSAGE_MAX, left));
    left -= text.length;
    out.push('', `--- ${ROLE[m.role] || m.role}, ${when(m.ts)}${i === f.at && uuid ? ' (the found message)' : ''} ---`, text);
  }
  return out.join('\n');
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(msg) {
  const { id, method, params = {} } = msg;
  if (method === 'initialize') {
    return { protocolVersion: params.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'session-history', version: VERSION }, instructions: INSTRUCTIONS };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };
  if (method === 'tools/call') {
    const run = { search_past_sessions: search, read_past_session: read }[params.name];
    if (!run) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
    try {
      return { content: [{ type: 'text', text: await run(params.arguments || {}) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: e.message }], isError: true }; // the model reads the reason
    }
  }
  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (msg.id === undefined || msg.id === null) return; // a notification (initialized, cancelled): nothing to answer
  handle(msg).then((result) => send({ id: msg.id, result }), (e) => send({ id: msg.id, error: { code: e.code || -32603, message: e.message } }));
}).on('close', () => process.exit(0));
process.on('uncaughtException', (e) => console.error(e.stack || e));
