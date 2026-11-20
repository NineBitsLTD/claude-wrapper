'use strict';
/**
 * Registers the session-history MCP server (sessions-mcp.js: Claude searches the project's earlier
 * sessions) the way any MCP server is — `claude mcp add --scope user` — so it is in every Claude's
 * MCP list, a chat's and a terminal's, and is switched on and off there like the others.
 *
 * The registration names a launcher in the extension's storage, not the extension's folder (that
 * changes with every version): the launcher is rewritten at each start to point to the installed
 * version, and finds the newest installed copy itself if that one is gone. claude starts the server
 * in the project's folder, which is the project it searches.
 *
 * Registered once: removed by the user (`claude mcp remove`), it stays removed; a server of the same
 * name that isn't this one is left alone.
 *
 *   await registerHistoryMcp({ storageDir, serverScript, runtime, claudeBin, env, state })
 *     -> 'registered' | 'updated' | 'unchanged' | 'removed by the user' | 'taken'
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const NAME = 'session-history';
const TOOLS = ['search_past_sessions', 'read_past_session'].map((t) => `mcp__${NAME}__${t}`);

function launcherCode(serverScript) {
  return `'use strict';
// Claude Wrapper's ${NAME} MCP server (search in the project's earlier sessions), as registered with
// \`claude mcp add --scope user\`. Rewritten by the extension at each start to point to its installed
// version; if that one is gone (updated meanwhile), the newest installed copy is used.
const fs = require('fs');
const path = require('path');
let target = ${JSON.stringify(serverScript)};
if (!fs.existsSync(target)) {
  const dir = path.dirname(path.dirname(path.dirname(target)));
  const version = (n) => n.replace(/^.*-(\\d+(?:\\.\\d+)*)$/, '$1').split('.').map(Number);
  const newer = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
  const found = fs.readdirSync(dir).filter((n) => /^ninebits\\.claude-wrapper-\\d/.test(n)).sort(newer).pop();
  if (found) target = path.join(dir, found, 'server', 'sessions-mcp.js');
}
require(target);
`;
}

function claudeConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')); } catch { return {}; }
}

function run(claudeBin, args, env) {
  return new Promise((resolve, reject) => {
    execFile(claudeBin, args, { env, timeout: 30000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(out)));
  });
}

/**
 * storageDir: the extension's storage (the launcher goes there, the server's data is there);
 * serverScript: this version's sessions-mcp.js; runtime: what runs Node (VS Code's Electron, told so
 * by ELECTRON_RUN_AS_NODE); env: for claude; state: { get(key), update(key, value) }.
 */
async function registerHistoryMcp({ storageDir, serverScript, runtime, claudeBin = 'claude', env = process.env, state }) {
  const dir = path.join(storageDir, 'mcp');
  const launcher = path.join(dir, `${NAME}.js`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(launcher, launcherCode(serverScript));

  const have = claudeConfig().mcpServers?.[NAME] || null;
  if (have && !(have.args || []).some((a) => String(a).endsWith(`${NAME}.js`))) return 'taken';
  if (!have && state.get('historyMcpRegistered')) return 'removed by the user';
  const same = have && have.command === runtime && have.args?.length === 1 && have.args[0] === launcher &&
    have.env?.ELECTRON_RUN_AS_NODE === '1' && have.env?.NINEBITS_DATA_DIR === storageDir;
  if (same) return 'unchanged';
  if (have) await run(claudeBin, ['mcp', 'remove', '--scope', 'user', NAME], env).catch(() => {});
  await run(claudeBin, ['mcp', 'add', '--scope', 'user', NAME, '-e', 'ELECTRON_RUN_AS_NODE=1', '-e', `NINEBITS_DATA_DIR=${storageDir}`, '--', runtime, launcher], env);
  await state.update('historyMcpRegistered', true);
  return have ? 'updated' : 'registered';
}

module.exports = { registerHistoryMcp, NAME, TOOLS };
