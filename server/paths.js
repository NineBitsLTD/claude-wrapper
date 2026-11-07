'use strict';
/**
 * Where the server keeps settings and runtime data.
 *
 * Standalone (`node server.js`): next to the code — .env and .run/ in this folder.
 * Inside the Claude-AI app: NINEBITS_DATA_DIR points to ~/Library/Application Support/<app>,
 * because the code then lives inside the read-only .app bundle.
 *
 * Relative paths in settings (CLAUDE_WEB_CLOUDFLARED, CLAUDE_WEB_TLS_*, CLAUDE_WEB_REGISTRY…)
 * are resolved against DATA_DIR.
 */
const path = require('path');

const DATA_DIR = process.env.NINEBITS_DATA_DIR ? path.resolve(process.env.NINEBITS_DATA_DIR) : __dirname;
const RUN_DIR = path.join(DATA_DIR, '.run');
const ENV_FILE = path.join(DATA_DIR, '.env');
const fromData = (p) => path.resolve(DATA_DIR, p);

module.exports = { DATA_DIR, RUN_DIR, ENV_FILE, fromData };
