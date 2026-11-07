'use strict';
/**
 * File operations of the file tree's context menu and drag and drop: info, copy (paste), move,
 * rename, delete, new folder, new file, show in Finder, upload.
 *
 * POST /api/fsop  { op, cwd, path, ... }   (paths are relative to the project folder `cwd`)
 *   info    { path }                       -> type, size (folders: total of their contents), dates, mode;
 *                                             text files also get `lines` (no NUL byte = text)
 *   copy    { srcCwd, src, path }          -> copies src (from project srcCwd) into folder `path`;
 *                                             a taken name gets " copy", " copy 2"… like Finder
 *   move    { path, dest }                 -> moves entry `path` into folder `dest` (a row dragged in
 *                                             the tree; never overwrites)
 *   rename  { path, name }                 -> new name in the same folder (never overwrites)
 *   delete  { path }                       -> moved to the Trash (~/.Trash), not erased
 *   mkdir   { path, name }                 -> new folder `name` in folder `path` (never overwrites)
 *   touch   { path, name }                 -> new empty file `name` in folder `path` (never overwrites)
 *   reveal  { path }                       -> shows the entry in Finder (`open -R`; the project
 *                                             folder itself is opened)
 *
 * POST /api/upload?cwd=&path=&name=[&url=]  body: the file's bytes (a file or picture dropped on the
 *   tree from outside). Saved as a new file `name` in folder `path`; a taken name gets " copy" like a
 *   paste. With `url` (http/https) the server downloads it instead (pictures dragged from other
 *   sites, which the page can't fetch because of CORS). -> { rel, name, size }
 *
 * Every path must stay inside its project. The entry itself is resolved without following a
 * final symlink, so renaming or deleting a link touches the link, not what it points to.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const INFO_MAX_ENTRIES = 50000; // folder size walk stops here (and reports it is partial)
const INFO_MAX_MS = 3000;
const LINES_MAX_BYTES = 256 * 1024 * 1024; // larger files are not read to count lines
const UPLOAD_URL_MS = 60000; // a download by URL gives up after this

class OpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The project root (real path) and the entry `rel` inside it: { root, abs, rel, st }. */
async function resolveEntry(resolveDir, cwd, rel, { mustExist = true } = {}) {
  const dir = await resolveDir(cwd);
  if (!dir) throw new OpError(404, 'Project folder not found');
  const root = await fs.promises.realpath(dir);
  const norm = path.normalize(String(rel || '.'));
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith('..' + path.sep)) throw new OpError(403, 'The path is outside the project folder');
  if (norm === '.') return { root, abs: root, rel: '', st: await fs.promises.stat(root) };
  // The parent may contain symlinks (resolved and checked); the last part is taken as is.
  let parent;
  try { parent = await fs.promises.realpath(path.join(root, path.dirname(norm))); } catch { throw new OpError(404, 'Not found'); }
  if (parent !== root && !parent.startsWith(root + path.sep)) throw new OpError(403, 'The path is outside the project folder');
  const abs = path.join(parent, path.basename(norm));
  const st = await fs.promises.lstat(abs).catch(() => null);
  if (mustExist && !st) throw new OpError(404, 'Not found');
  return { root, abs, rel: path.relative(root, abs).split(path.sep).join('/'), st };
}

/** Folder `rel` (real path inside the project) where pasted entries go. */
async function resolveFolder(resolveDir, cwd, rel) {
  const e = await resolveEntry(resolveDir, cwd, rel);
  const real = await fs.promises.realpath(e.abs);
  if (real !== e.root && !real.startsWith(e.root + path.sep)) throw new OpError(403, 'The path is outside the project folder');
  if (!(await fs.promises.stat(real)).isDirectory()) throw new OpError(400, 'Not a folder');
  return { ...e, abs: real };
}

function validName(name) {
  name = String(name || '').trim();
  if (!name || name === '.' || name === '..' || /[/\0]/.test(name)) throw new OpError(400, 'Invalid name');
  if (Buffer.byteLength(name) > 255) throw new OpError(400, 'The name is too long');
  return name;
}

const exists = (p) => fs.promises.lstat(p).then(() => true, () => false);

/** "a.txt" -> "a copy.txt", "a copy 2.txt", … (folders and dotfiles keep the whole name). */
async function freeName(dir, name) {
  if (!(await exists(path.join(dir, name)))) return name;
  const ext = name.startsWith('.') ? '' : path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 1; i < 1000; i++) {
    const candidate = `${base} copy${i > 1 ? ' ' + i : ''}${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new OpError(409, 'Could not find a free name');
}

async function folderStats(dir) {
  const started = Date.now();
  let size = 0, files = 0, folders = 0, partial = false;
  const stack = [dir];
  while (stack.length) {
    if (files + folders > INFO_MAX_ENTRIES || Date.now() - started > INFO_MAX_MS) { partial = true; break; }
    const d = stack.pop();
    const items = await fs.promises.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) { folders++; stack.push(p); continue; }
      files++;
      size += (await fs.promises.lstat(p).catch(() => null))?.size || 0;
    }
  }
  return { size, files, folders, partial };
}

/** Line count of a text file, or null when it is binary (has a NUL byte) or too large. */
async function countLines(file, size) {
  if (size > LINES_MAX_BYTES) return null;
  let lines = 0, last = 10;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    if (chunk.includes(0)) return null;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
    last = chunk[chunk.length - 1];
  }
  return last === 10 ? lines : lines + 1; // a last line without "\n" counts too
}

function modeString(mode) {
  return [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1].map((bit, i) => (mode & bit ? 'rwx'[i % 3] : '-')).join('');
}

async function info(resolveDir, body) {
  const e = await resolveEntry(resolveDir, body.cwd, body.path);
  const st = e.st;
  const out = {
    name: path.basename(e.abs), rel: e.rel, abs: e.abs,
    type: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file',
    size: st.size, mtime: st.mtime.toISOString(), birthtime: st.birthtime.toISOString(),
    mode: modeString(st.mode), owner: st.uid === process.getuid?.() ? os.userInfo().username : String(st.uid),
  };
  if (st.isSymbolicLink()) {
    out.target = await fs.promises.readlink(e.abs).catch(() => null);
    const t = await fs.promises.stat(e.abs).catch(() => null);
    out.targetType = t ? (t.isDirectory() ? 'dir' : 'file') : 'missing';
  }
  if (st.isDirectory()) Object.assign(out, await folderStats(e.abs));
  if (st.isFile()) out.lines = await countLines(e.abs, st.size).catch(() => null);
  return out;
}

async function copy(resolveDir, body) {
  const src = await resolveEntry(resolveDir, body.srcCwd || body.cwd, body.src);
  if (!src.rel) throw new OpError(400, 'The whole project folder can’t be copied');
  const dest = await resolveFolder(resolveDir, body.cwd, body.path);
  if (src.st.isDirectory() && (dest.abs === src.abs || dest.abs.startsWith(src.abs + path.sep))) {
    throw new OpError(400, 'A folder can’t be pasted into itself');
  }
  const name = await freeName(dest.abs, path.basename(src.abs));
  const target = path.join(dest.abs, name);
  // verbatimSymlinks: links are copied as links, as they are (not resolved, not followed).
  await fs.promises.cp(src.abs, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  return { rel: path.relative(dest.root, target).split(path.sep).join('/'), name };
}

async function move(resolveDir, body) {
  const src = await resolveEntry(resolveDir, body.cwd, body.path);
  if (!src.rel) throw new OpError(400, 'The project folder can’t be moved');
  const dest = await resolveFolder(resolveDir, body.cwd, body.dest);
  const name = path.basename(src.abs);
  if (dest.abs === path.dirname(src.abs)) return { rel: src.rel, name, same: true };
  if (src.st.isDirectory() && dest.abs.startsWith(src.abs + path.sep)) throw new OpError(400, 'A folder can’t be moved into itself');
  const target = path.join(dest.abs, name);
  // rename() would replace an existing file silently.
  if (await exists(target)) throw new OpError(409, `The folder already has “${name}”`);
  try {
    await fs.promises.rename(src.abs, target);
  } catch (err) {
    if (err.code === 'EXDEV') throw new OpError(409, 'The folder is on another disk: copy with ⌥');
    throw err;
  }
  return { rel: path.relative(dest.root, target).split(path.sep).join('/'), name };
}

async function rename(resolveDir, body) {
  const e = await resolveEntry(resolveDir, body.cwd, body.path);
  if (!e.rel) throw new OpError(400, 'The project folder can’t be renamed here');
  const name = validName(body.name);
  const target = path.join(path.dirname(e.abs), name);
  if (target === e.abs) return { rel: e.rel, name };
  // Case-only renames on a case-insensitive disk point at the same entry: allowed.
  const other = await fs.promises.lstat(target).catch(() => null);
  if (other && !(other.ino === e.st.ino && other.dev === e.st.dev)) throw new OpError(409, `“${name}” already exists`);
  await fs.promises.rename(e.abs, target);
  return { rel: path.relative(e.root, target).split(path.sep).join('/'), name };
}

async function trash(resolveDir, body) {
  const e = await resolveEntry(resolveDir, body.cwd, body.path);
  if (!e.rel) throw new OpError(400, 'The project folder can’t be deleted here');
  const trashDir = path.join(os.homedir(), '.Trash');
  if (process.platform !== 'darwin' || !(await exists(trashDir))) throw new OpError(501, 'The Trash is available only on macOS');
  const name = await freeName(trashDir, path.basename(e.abs));
  try {
    await fs.promises.rename(e.abs, path.join(trashDir, name));
  } catch (err) {
    // Another disk: the Trash there is a different folder; erasing instead would be irreversible.
    if (err.code === 'EXDEV') throw new OpError(409, 'The file is on another disk: delete it in Finder');
    throw err;
  }
  return { trashed: name };
}

/** New folder or empty file `body.name` in folder `body.path`; a taken name is an error. */
async function create(resolveDir, body, isDir) {
  const dest = await resolveFolder(resolveDir, body.cwd, body.path);
  const name = validName(body.name);
  const target = path.join(dest.abs, name);
  try {
    if (isDir) await fs.promises.mkdir(target);
    else await (await fs.promises.open(target, 'wx')).close();
  } catch (err) {
    if (err.code === 'EEXIST') throw new OpError(409, `“${name}” already exists`);
    throw err;
  }
  return { rel: path.relative(dest.root, target).split(path.sep).join('/'), name };
}

async function reveal(resolveDir, body) {
  const e = await resolveEntry(resolveDir, body.cwd, body.path);
  if (process.platform !== 'darwin') throw new OpError(501, 'Finder exists only on macOS');
  await new Promise((resolve, reject) => {
    const child = spawn('open', e.rel ? ['-R', e.abs] : [e.abs], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new OpError(500, `open exited with code ${code}`))));
  });
  return {};
}

const OPS = {
  info, copy, move, rename, delete: trash, reveal,
  mkdir: (resolveDir, body) => create(resolveDir, body, true),
  touch: (resolveDir, body) => create(resolveDir, body, false),
};

/** Handles POST /api/fsop; `deps` = { resolveDir, readJsonBody, sendJson }. */
async function handleFsOp(req, res, { resolveDir, readJsonBody, sendJson }) {
  let body;
  try { body = await readJsonBody(req, 64 * 1024); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
  const op = OPS[body.op];
  if (!op) return sendJson(res, 400, { error: 'Unknown operation' });
  try {
    sendJson(res, 200, await op(resolveDir, body));
  } catch (e) {
    const status = e.status || (e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'EEXIST' ? 409 : 500);
    sendJson(res, status, { error: e instanceof OpError ? e.message : `${e.code || 'Error'}: ${e.message}` });
  }
}

/** Handles POST /api/upload (see the header); `deps` = { resolveDir, sendJson }. */
async function handleUpload(req, res, url, { resolveDir, sendJson }) {
  const q = url.searchParams;
  let target = null;
  try {
    const dest = await resolveFolder(resolveDir, q.get('cwd'), q.get('path'));
    let body = req;
    let type = '';
    const src = q.get('url');
    if (src) {
      if (!/^https?:\/\//i.test(src)) throw new OpError(400, 'Only http/https can be downloaded');
      req.resume();
      const r = await fetch(src, { signal: AbortSignal.timeout(UPLOAD_URL_MS) }).catch((e) => { throw new OpError(502, 'Could not download: ' + e.message); });
      if (!r.ok || !r.body) throw new OpError(502, `Could not download: HTTP ${r.status}`);
      body = Readable.fromWeb(r.body);
      type = r.headers.get('content-type') || '';
    }
    let name = validName(q.get('name'));
    // A downloaded picture named after a URL without an extension gets one from its type.
    const ext = src && !path.extname(name) && /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)\b/.exec(type);
    if (ext) name += '.' + ({ jpeg: 'jpg', 'svg+xml': 'svg' }[ext[1]] || ext[1]);
    name = await freeName(dest.abs, name);
    const file = path.join(dest.abs, name);
    const fh = await fs.promises.open(file, 'wx');
    target = file;
    await pipeline(body, fh.createWriteStream());
    target = null;
    const st = await fs.promises.stat(file);
    sendJson(res, 200, { rel: path.relative(dest.root, file).split(path.sep).join('/'), name, size: st.size });
  } catch (e) {
    // A broken upload must not leave half a file behind.
    if (target) await fs.promises.rm(target, { force: true }).catch(() => {});
    if (res.headersSent || res.destroyed) return;
    const status = e.status || (e.code === 'EACCES' || e.code === 'EPERM' ? 403 : e.code === 'EEXIST' ? 409 : e.code === 'ENOSPC' ? 507 : 500);
    sendJson(res, status, { error: e instanceof OpError ? e.message : `${e.code || 'Error'}: ${e.message}` });
  }
}

module.exports = { handleFsOp, handleUpload };
