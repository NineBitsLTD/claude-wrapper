'use strict';
/**
 * Text search in a folder of the project for the file tree's search panel (like VS Code's
 * "Find in Files"): names of files and folders, and lines of text files.
 *
 * GET /api/search?cwd=&path=&q=[&case=1][&word=1][&regex=1][&hidden=1][&names=0][&content=0]
 *   `path` is the folder searched (relative to the project `cwd`, must stay inside it).
 *   Streams NDJSON, one object per line:
 *     { type: 'name', rel, isDir }                    a file or folder whose name matches
 *     { type: 'file', rel, matches: [{ line, col, len, text, at }], more }
 *                                                     a text file with matching lines; `line` and
 *                                                     `col` are 1-based, `text` is the line (cut
 *                                                     around the match when long), the match is at
 *                                                     `at` in it; `more` = matches not listed
 *     { type: 'progress', scanned }                  from time to time on a long search
 *     { type: 'done', scanned, files, matches, truncated, ms }
 *   An invalid regular expression is a 400 before the stream starts.
 *
 * Skipped like VS Code's default excludes: `.git` and `node_modules`; dot entries unless `hidden`;
 * symlinks are not followed (no loops, nothing outside the project); binary files (a NUL byte in
 * the first 8 KB) and files over CONTENT_MAX_BYTES are matched by name only. The search stops at
 * MAX_MATCHES, after MAX_MS, or when the client goes away.
 */
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const CONTENT_MAX_BYTES = 5 * 1024 * 1024;
const MAX_MATCHES = 5000;      // all files together
const FILE_MAX_MATCHES = 200;  // listed per file (the rest is counted in `more`)
const MAX_NAMES = 1000;
const MAX_MS = 30000;
const LINE_MAX = 240;          // longer lines are cut around the match
const PROGRESS_EVERY = 500;    // files

/** The query as a global RegExp, or throws with a message for the user. */
function buildRegex(q, { regex, matchCase, word }) {
  let src = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b knows only Latin letters: word boundaries by Unicode letters and digits instead.
  if (word) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(src, 'gu' + (matchCase ? '' : 'i'));
  } catch (e) {
    throw new Error('Invalid regular expression: ' + e.message.replace(/^Invalid regular expression: /, ''));
  }
}

/** Matching lines of `text`: [{ line, col, len, text, at }] (at most `limit`) and the total count. */
function matchLines(text, re, limit) {
  const out = [];
  let total = 0;
  let line = 1;
  for (const raw of text.split('\n')) {
    const s = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s))) {
      if (m[0] === '') { re.lastIndex++; if (re.lastIndex > s.length) break; continue; } // empty matches are not results
      total++;
      if (out.length < limit) out.push(preview(s, line, m.index, m[0].length));
    }
    line++;
  }
  return { out, total };
}

/** The line around a match: leading spaces dropped, a long line cut with "…". */
function preview(s, line, index, len) {
  const lead = Math.min(s.length - s.trimStart().length, index);
  let from = lead, to = s.length;
  if (to - from > LINE_MAX) {
    from = Math.max(lead, index - 60);
    to = Math.min(s.length, Math.max(index + len, from + LINE_MAX));
  }
  const pre = from > lead ? '…' : '';
  const post = to < s.length ? '…' : '';
  return { line, col: index + 1, len, text: pre + s.slice(from, to) + post, at: pre.length + index - from };
}

async function isBinary(fh) {
  const buf = Buffer.alloc(8192);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  return buf.subarray(0, bytesRead).includes(0);
}

/** Handles GET /api/search (see the header); `deps` = { resolveInProject, sendJson }. */
async function handleSearch(url, res, { resolveInProject, sendJson }) {
  const p = url.searchParams;
  const q = p.get('q') || '';
  if (!q) return sendJson(res, 400, { error: 'Empty query' });
  let re;
  try {
    re = buildRegex(q, { regex: p.get('regex') === '1', matchCase: p.get('case') === '1', word: p.get('word') === '1' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const r = await resolveInProject(url, res);
  if (!r) return;
  const st = await fs.promises.stat(r.real).catch(() => null);
  if (!st?.isDirectory()) return sendJson(res, 400, { error: 'Not a folder' });

  const hidden = p.get('hidden') === '1';
  const names = p.get('names') !== '0';
  const content = p.get('content') !== '0';
  const base = r.rel === '.' ? '' : r.rel.split(path.sep).join('/');
  const started = Date.now();
  let closed = false;
  res.on('close', () => { closed = true; }); // not req's: that fires once a GET's (empty) body is read
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  const send = (o) => { if (!closed) res.write(JSON.stringify(o) + '\n'); };

  let scanned = 0, files = 0, matches = 0, nameCount = 0, truncated = false;
  const stop = () => {
    if (closed) return true;
    if (matches >= MAX_MATCHES || Date.now() - started > MAX_MS) { truncated = true; return true; }
    return false;
  };
  const nameMatches = (name) => { re.lastIndex = 0; const m = re.exec(name); return !!m && m[0] !== ''; };

  // Depth-first in the tree's order: folders first, then files, by name.
  const stack = [{ abs: r.real, rel: base }];
  outer: while (stack.length) {
    const dir = stack.pop();
    let dirents;
    try { dirents = await fs.promises.readdir(dir.abs, { withFileTypes: true }); } catch { continue; }
    dirents = dirents.filter((d) => (hidden || !d.name.startsWith('.')) && !(d.isDirectory() && SKIP_DIRS.has(d.name)));
    dirents.sort((a, b) => (a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.isDirectory() ? -1 : 1));
    const subdirs = [];
    for (const d of dirents) {
      if (stop()) break outer;
      const rel = dir.rel ? `${dir.rel}/${d.name}` : d.name;
      const abs = path.join(dir.abs, d.name);
      if (names && nameCount < MAX_NAMES && nameMatches(d.name)) {
        nameCount++;
        send({ type: 'name', rel, isDir: d.isDirectory() });
      }
      if (d.isDirectory()) { subdirs.push({ abs, rel }); continue; }
      if (!d.isFile() || !content) continue;
      scanned++;
      if (scanned % PROGRESS_EVERY === 0) send({ type: 'progress', scanned });
      let fh;
      try {
        fh = await fs.promises.open(abs, 'r');
        const fst = await fh.stat();
        if (fst.size === 0 || fst.size > CONTENT_MAX_BYTES || (await isBinary(fh))) continue;
        const text = (await fh.readFile()).toString('utf8');
        const { out, total } = matchLines(text, re, Math.min(FILE_MAX_MATCHES, MAX_MATCHES - matches));
        if (!total) continue;
        files++;
        matches += out.length;
        send({ type: 'file', rel, matches: out, more: total - out.length });
      } catch {
        // unreadable: skipped
      } finally {
        await fh?.close().catch(() => {});
      }
    }
    // Pushed in reverse so the first folder is searched next.
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
  send({ type: 'done', scanned, files, matches, names: nameCount, truncated: truncated || nameCount >= MAX_NAMES, ms: Date.now() - started });
  res.end();
}

module.exports = { handleSearch };
