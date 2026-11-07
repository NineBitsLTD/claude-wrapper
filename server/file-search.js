'use strict';
/**
 * Project file list for @-mentions in the message box: `git ls-files` in a git repository
 * (respects .gitignore), otherwise a bounded walk that skips the usual heavy folders.
 * The list is cached per folder for a few seconds; matching is a ranked subsequence search.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CACHE_MS = 10000;
const MAX_FILES = 50000;
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', 'venv', '__pycache__', '.cache', '.run', 'coverage', '.idea', '.DS_Store']);
const cache = new Map(); // cwd -> { at, files }

function gitFiles(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, out) => {
      resolve(err ? null : out.split('\n').filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

async function walk(cwd) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop();
    const items = await fs.promises.readdir(path.join(cwd, rel), { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      if (SKIP.has(it.name)) continue;
      const p = rel ? `${rel}/${it.name}` : it.name;
      if (it.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

async function listFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = (await gitFiles(cwd)) || (await walk(cwd));
  // Folders can be mentioned too: add each file's parent folders once.
  const dirs = new Set();
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i) + '/');
  const all = [...dirs, ...files];
  cache.set(cwd, { at: Date.now(), files: all });
  return all;
}

/** Score of `q` as a subsequence of `p` (higher is better), or -1. Name matches beat path matches. */
function score(p, q) {
  const lp = p.toLowerCase();
  const name = lp.slice(lp.lastIndexOf('/', lp.length - 2) + 1);
  if (name.startsWith(q)) return 1000 - p.length;
  if (name.includes(q)) return 800 - p.length;
  if (lp.includes(q)) return 600 - p.length;
  let i = 0, gaps = 0, last = -1;
  for (const ch of q) {
    const j = lp.indexOf(ch, i);
    if (j < 0) return -1;
    if (last >= 0 && j > last + 1) gaps++;
    last = j;
    i = j + 1;
  }
  return 300 - gaps * 10 - p.length;
}

async function search(cwd, q, limit = 30) {
  const files = await listFiles(cwd);
  q = String(q || '').toLowerCase().replace(/^@/, '');
  if (!q) return files.filter((f) => !f.includes('/') || /^[^/]+\/$/.test(f)).slice(0, limit); // top level first
  const ranked = [];
  for (const f of files) {
    const s = score(f, q);
    if (s >= 0) ranked.push([s, f]);
  }
  return ranked.sort((a, b) => b[0] - a[0]).slice(0, limit).map((x) => x[1]);
}

module.exports = { search };
