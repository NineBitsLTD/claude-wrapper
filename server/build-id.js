'use strict';
/**
 * The server code's fingerprint: a hash of the names, sizes and modification times of the files in
 * this folder (without data: .run/, .env, macOS ._* files). The server reports the one it started
 * with in /api/info; the extension computes it again and replaces a server whose code has changed
 * since (a version bump alone misses edits made between versions).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKIP = /^(\.run|\.env|\._.*|\.DS_Store|node_modules)$/;

function buildId(dir = __dirname) {
  const hash = crypto.createHash('sha1');
  const walk = (d, rel) => {
    let names;
    try { names = fs.readdirSync(d).sort(); } catch { return; }
    for (const name of names) {
      if (SKIP.test(name)) continue;
      const abs = path.join(d, name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, rel + name + '/');
      else hash.update(`${rel}${name}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
    }
  };
  walk(dir, '');
  return hash.digest('hex').slice(0, 16);
}

module.exports = { buildId };
