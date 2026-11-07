'use strict';
/**
 * Metadata tags of an audio file for the viewer panel (GET /api/audiotags), read with plain file
 * reads — no decoding, no dependencies. The container is detected by its magic bytes:
 *
 *   ID3v2 (2.2–2.4) at the start and ID3v1 at the end   MP3, AAC, anything with an ID3 header
 *                                                       (ID3v1 tags only when there is no ID3v2)
 *   FLAC metadata blocks (Vorbis comments, pictures)    .flac
 *   Ogg Vorbis / Opus comment packet                    .ogg .oga .opus
 *   MP4 moov/udta/meta/ilst items                       .m4a .aac (MP4)
 *   RIFF LIST/INFO and an embedded "id3 " chunk         .wav
 *
 * readAudioTags: { format, tags: [{ id, key?, value }], cover } — `id` is the tag as stored (TIT2,
 * ARTIST, ©nam, INAM…), `key` a common name when known (title, artist, album, …) for the page to
 * label, `value` text. Pictures are summarised in tags ("image/jpeg, 120 KB"); `cover` says whether
 * one can be shown. readAudioCover (GET /api/audiocover): { type, data } of the embedded picture —
 * the front cover if marked, else the first — when its bytes are JPEG/PNG/GIF/WebP, else null.
 * WebM has no reader: no tags.
 */
const fs = require('fs');

const MAX_VALUE = 4000;            // longer values (lyrics) are cut
const MAX_TAGS = 200;
const MAX_BLOCK = 4 * 1024 * 1024; // comment packets / blocks read at most this much
const MAX_PICTURE = 20 * 1024 * 1024;

const ID3_KEYS = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TPE2: 'albumartist', TYER: 'date', TDRC: 'date',
  TRCK: 'track', TPOS: 'disc', TCON: 'genre', COMM: 'comment', TCOM: 'composer', USLT: 'lyrics',
  TSSE: 'encoder', TENC: 'encodedby', TCOP: 'copyright', TBPM: 'bpm', APIC: 'picture',
  TT2: 'title', TP1: 'artist', TAL: 'album', TP2: 'albumartist', TYE: 'date', TRK: 'track',
  TPA: 'disc', TCO: 'genre', COM: 'comment', TCM: 'composer', ULT: 'lyrics', TSS: 'encoder',
  TEN: 'encodedby', TCR: 'copyright', TBP: 'bpm', PIC: 'picture',
};
const VORBIS_KEYS = {
  TITLE: 'title', ARTIST: 'artist', ALBUM: 'album', ALBUMARTIST: 'albumartist', 'ALBUM ARTIST': 'albumartist',
  DATE: 'date', YEAR: 'date', TRACKNUMBER: 'track', DISCNUMBER: 'disc', GENRE: 'genre', COMMENT: 'comment',
  DESCRIPTION: 'comment', COMPOSER: 'composer', LYRICS: 'lyrics', ENCODER: 'encoder', ENCODEDBY: 'encodedby',
  COPYRIGHT: 'copyright', BPM: 'bpm', METADATA_BLOCK_PICTURE: 'picture',
};
const MP4_KEYS = {
  '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumartist', '©day': 'date', trkn: 'track',
  disk: 'disc', '©gen': 'genre', gnre: 'genre', '©cmt': 'comment', '©wrt': 'composer', '©lyr': 'lyrics',
  '©too': 'encoder', cprt: 'copyright', tmpo: 'bpm', covr: 'picture',
};
const RIFF_KEYS = {
  INAM: 'title', IART: 'artist', IPRD: 'album', ICRD: 'date', ITRK: 'track', IPRT: 'track', IGNR: 'genre',
  ICMT: 'comment', ISFT: 'encoder', ICOP: 'copyright',
};
// ID3v1 genres 0–79 (the original list); "(17)" in ID3v2 TCON refers to these too.
const GENRES = ('Blues,Classic Rock,Country,Dance,Disco,Funk,Grunge,Hip-Hop,Jazz,Metal,New Age,Oldies,Other,Pop,R&B,Rap,' +
  'Reggae,Rock,Techno,Industrial,Alternative,Ska,Death Metal,Pranks,Soundtrack,Euro-Techno,Ambient,Trip-Hop,Vocal,' +
  'Jazz+Funk,Fusion,Trance,Classical,Instrumental,Acid,House,Game,Sound Clip,Gospel,Noise,AlternRock,Bass,Soul,Punk,' +
  'Space,Meditative,Instrumental Pop,Instrumental Rock,Ethnic,Gothic,Darkwave,Techno-Industrial,Electronic,Pop-Folk,' +
  'Eurodance,Dream,Southern Rock,Comedy,Cult,Gangsta,Top 40,Christian Rap,Pop/Funk,Jungle,Native American,Cabaret,' +
  'New Wave,Psychedelic,Rave,Showtunes,Trailer,Lo-Fi,Tribal,Acid Punk,Acid Jazz,Polka,Retro,Musical,Rock & Roll,Hard Rock').split(',');

const kb = (n) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024).toLocaleString('en-US')} KB`);

class Reader {
  constructor(fh, size) { this.fh = fh; this.size = size; }
  async read(pos, len) {
    len = Math.max(0, Math.min(len, this.size - pos));
    const buf = Buffer.alloc(len);
    const { bytesRead } = await this.fh.read(buf, 0, len, pos);
    return buf.subarray(0, bytesRead);
  }
}

/** Image type by its first bytes (the declared MIME type is not trusted), or null. */
function imageType(b) {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

class Tags {
  constructor() { this.list = []; this.picture = null; }
  /** Keeps one picture: the front cover (type 3) wins over others, else the first one. */
  addPicture(data, kind = 3) {
    const type = imageType(data);
    if (!type || (this.picture && (this.picture.kind === 3 || kind !== 3))) return;
    this.picture = { type, data, kind };
  }
  add(id, key, value) {
    value = String(value ?? '').replace(/\0+$/, '').trim();
    if (!value || this.list.length >= MAX_TAGS) return;
    if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE) + '…';
    this.list.push(key ? { id, key, value } : { id, value });
  }
}

// ---------- ID3 ----------

const synchsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

/** Removes ID3 unsynchronisation (0xFF 0x00 -> 0xFF). */
function unsync(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    out.push(buf[i]);
    if (buf[i] === 0xff && buf[i + 1] === 0) i++;
  }
  return Buffer.from(out);
}

/** Text in ID3 encoding `enc` (0 latin1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8). */
function decodeText(buf, enc) {
  if (enc === 1 || enc === 2) {
    let le = enc === 1;
    if (buf[0] === 0xff && buf[1] === 0xfe) { le = true; buf = buf.subarray(2); }
    else if (buf[0] === 0xfe && buf[1] === 0xff) { le = false; buf = buf.subarray(2); }
    buf = buf.subarray(0, buf.length & ~1);
    if (!le) buf = Buffer.from(buf).swap16();
    return buf.toString('utf16le');
  }
  return buf.toString(enc === 3 ? 'utf8' : 'latin1');
}

/** Splits at the first terminator of encoding `enc`: [before, after]. */
function splitTerm(buf, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = 0; i + 1 < buf.length; i += 2) if (buf[i] === 0 && buf[i + 1] === 0) return [buf.subarray(0, i), buf.subarray(i + 2)];
  } else {
    const i = buf.indexOf(0);
    if (i >= 0) return [buf.subarray(0, i), buf.subarray(i + 1)];
  }
  return [buf, Buffer.alloc(0)];
}

function genreName(v) {
  // "(17)", "17" or "(17)Rock" -> the ID3v1 name; anything else as is.
  return v.replace(/^\((\d+)\)$|^(\d+)$/, (m, a, b) => GENRES[Number(a ?? b)] || m).replace(/^\((\d+)\)(?=\D)/, '');
}

function id3Frame(tags, id, data) {
  const key = ID3_KEYS[id];
  if (id === 'APIC' || id === 'PIC') {
    const enc = data[0];
    let rest = data.subarray(1), mime;
    if (id === 'PIC') { mime = 'image/' + rest.subarray(0, 3).toString('latin1').toLowerCase(); rest = rest.subarray(3); }
    else { const i = rest.indexOf(0); mime = rest.subarray(0, i).toString('latin1'); rest = rest.subarray(i + 1); }
    const [, img] = splitTerm(rest.subarray(1), enc); // picture type, description, data
    tags.addPicture(img, rest[0]);
    return tags.add(id, key, `${mime || 'image'}, ${kb(img.length)}`);
  }
  if (id === 'TXXX' || id === 'TXX') {
    const [desc, value] = splitTerm(data.subarray(1), data[0]);
    const d = decodeText(desc, data[0]);
    return tags.add(d || id, VORBIS_KEYS[d.toUpperCase()], decodeText(value, data[0]));
  }
  if (id === 'COMM' || id === 'COM' || id === 'USLT' || id === 'ULT') {
    const [desc, value] = splitTerm(data.subarray(4), data[0]);
    const d = decodeText(desc, data[0]), itunes = d.startsWith('iTun'); // iTunNORM etc.: technical data
    return tags.add(d && !itunes ? `${id} (${d})` : id, itunes ? null : key, decodeText(value, data[0]));
  }
  if (id[0] === 'T') {
    const value = decodeText(data.subarray(1), data[0]).split('\0').filter(Boolean).join(', ');
    return tags.add(id, key, id === 'TCON' || id === 'TCO' ? genreName(value) : value);
  }
  if (id === 'WXXX' || id === 'WXX') {
    const [desc, url] = splitTerm(data.subarray(1), data[0]);
    return tags.add(decodeText(desc, data[0]) || id, null, url.toString('latin1'));
  }
  if (id[0] === 'W') return tags.add(id, null, data.toString('latin1'));
}

/** ID3v2 tag at `pos`; returns its total length, or 0 when there is none. */
async function readId3v2(r, tags, pos = 0) {
  const h = await r.read(pos, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return 0;
  const ver = h[3], flags = h[5], size = synchsafe(h, 6);
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (ver < 2 || ver > 4) return total;
  let body = await r.read(pos + 10, Math.min(size, 64 * 1024 * 1024));
  if (ver < 4 && flags & 0x80) body = unsync(body);
  let o = 0;
  if (flags & 0x40) o = ver === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
  const idLen = ver === 2 ? 3 : 4, hLen = ver === 2 ? 6 : 10;
  while (o + hLen <= body.length) {
    const id = body.toString('latin1', o, o + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const len = ver === 2 ? body.readUIntBE(o + 3, 3) : ver === 4 ? synchsafe(body, o + 4) : body.readUInt32BE(o + 4);
    const fflags = ver === 2 ? 0 : body.readUInt16BE(o + 8);
    let data = body.subarray(o + hLen, o + hLen + len);
    o += hLen + len;
    if (ver === 4) {
      if (fflags & 0x0c) continue; // compressed or encrypted
      if (fflags & 0x01) data = data.subarray(4); // data length indicator
      if (fflags & 0x02) data = unsync(data);
    } else if (ver === 3 && fflags & 0xc0) continue;
    if (data.length) id3Frame(tags, id, data);
  }
  return total;
}

/** ID3v1 at the end of the file; its tags are added only when `add` (it repeats ID3v2 otherwise). */
async function readId3v1(r, tags, add) {
  if (r.size < 128) return false;
  const b = await r.read(r.size - 128, 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return false;
  if (!add) return true;
  // Latin-1 by the spec, but some writers put UTF-8 there.
  const str = (from, len) => {
    const raw = b.subarray(from, from + len), end = raw.indexOf(0);
    const field = end >= 0 ? raw.subarray(0, end) : raw;
    const utf8 = field.toString('utf8');
    return (utf8.includes('\ufffd') ? field.toString('latin1') : utf8).trim();
  };
  tags.add('ID3v1 title', 'title', str(3, 30));
  tags.add('ID3v1 artist', 'artist', str(33, 30));
  tags.add('ID3v1 album', 'album', str(63, 30));
  tags.add('ID3v1 year', 'date', str(93, 4));
  tags.add('ID3v1 comment', 'comment', str(97, b[125] === 0 && b[126] ? 28 : 30));
  if (b[125] === 0 && b[126]) tags.add('ID3v1 track', 'track', String(b[126]));
  if (GENRES[b[127]]) tags.add('ID3v1 genre', 'genre', GENRES[b[127]]);
  return true;
}

// ---------- Vorbis comments (FLAC, Ogg) ----------

/** FLAC METADATA_BLOCK_PICTURE (type, mime, description, size, colours, data): its summary. */
function pictureBlock(tags, b) {
  try {
    let o = 4;
    const mimeLen = b.readUInt32BE(o); const mime = b.toString('latin1', o + 4, o + 4 + mimeLen); o += 4 + mimeLen;
    o += 4 + b.readUInt32BE(o);
    const w = b.readUInt32BE(o), h = b.readUInt32BE(o + 4); o += 16;
    const len = b.readUInt32BE(o);
    tags.addPicture(b.subarray(o + 4, o + 4 + len), b.readUInt32BE(0));
    return `${mime || 'image'}, ${w}×${h}, ${kb(len)}`;
  } catch { return 'image'; }
}

function vorbisComments(tags, b) {
  try {
    let o = 4 + b.readUInt32LE(0);
    tags.add('vendor', null, b.toString('utf8', 4, o));
    const n = b.readUInt32LE(o); o += 4;
    for (let i = 0; i < n && o + 4 <= b.length; i++) {
      const len = b.readUInt32LE(o);
      const s = b.toString('utf8', o + 4, Math.min(b.length, o + 4 + len));
      o += 4 + len;
      const eq = s.indexOf('=');
      if (eq < 1) continue;
      const id = s.slice(0, eq).toUpperCase(), value = s.slice(eq + 1);
      if (id === 'METADATA_BLOCK_PICTURE') tags.add(id, 'picture', pictureBlock(tags, Buffer.from(value, 'base64')));
      else tags.add(id, VORBIS_KEYS[id], value);
    }
  } catch {} // a truncated packet: keep what was read
}

async function readFlac(r, tags, pos) {
  pos += 4;
  for (let last = false; !last && pos + 4 <= r.size;) {
    const h = await r.read(pos, 4);
    last = !!(h[0] & 0x80);
    const type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
    if (type === 4) vorbisComments(tags, await r.read(pos + 4, Math.min(len, MAX_BLOCK)));
    if (type === 6) tags.add('PICTURE', 'picture', pictureBlock(tags, await r.read(pos + 4, Math.min(len, MAX_PICTURE))));
    pos += 4 + len;
  }
}

async function readOgg(r, tags) {
  // Reassembles the first stream's second packet (the comment header) from its pages.
  const parts = [];
  let packets = 0, pos = 0, got = 0, serial = null;
  while (pos + 27 <= r.size && got < MAX_BLOCK) {
    const h = await r.read(pos, 27);
    if (h.toString('latin1', 0, 4) !== 'OggS') break;
    const nseg = h[26];
    const table = await r.read(pos + 27, nseg);
    let o = pos + 27 + nseg;
    pos = o + table.reduce((a, b) => a + b, 0);
    if (serial === null) serial = h.readUInt32LE(14);
    else if (h.readUInt32LE(14) !== serial) continue;
    for (const seg of table) {
      if (packets === 1) { parts.push(await r.read(o, seg)); got += seg; }
      o += seg;
      if (seg < 255 && ++packets === 2) break;
    }
    if (packets >= 2) break;
  }
  const p = Buffer.concat(parts);
  if (p.toString('latin1', 1, 7) === 'vorbis' && p[0] === 3) vorbisComments(tags, p.subarray(7));
  else if (p.toString('latin1', 0, 8) === 'OpusTags') vorbisComments(tags, p.subarray(8));
}

// ---------- MP4 ----------

async function* atoms(r, start, end) {
  for (let pos = start; pos + 8 <= end;) {
    const h = await r.read(pos, 16);
    let size = h.readUInt32BE(0), hdr = 8;
    if (size === 1) { size = Number(h.readBigUInt64BE(8)); hdr = 16; }
    else if (size === 0) size = end - pos;
    if (size < hdr) return;
    yield { type: h.toString('latin1', 4, 8), start: pos + hdr, end: Math.min(end, pos + size) };
    pos += size;
  }
}

async function child(r, parent, type) {
  for await (const a of atoms(r, parent.start, parent.end)) if (a.type === type) return a;
  return null;
}

async function readMp4(r, tags) {
  const moov = await child(r, { start: 0, end: r.size }, 'moov');
  if (!moov) return;
  const udta = await child(r, moov, 'udta');
  const meta = (udta && await child(r, udta, 'meta')) || await child(r, moov, 'meta');
  if (!meta) return;
  const ilst = await child(r, { start: meta.start + 4, end: meta.end }, 'ilst'); // meta is a full box
  if (!ilst) return;
  for await (const item of atoms(r, ilst.start, ilst.end)) {
    let id = item.type, name = null;
    for await (const a of atoms(r, item.start, item.end)) {
      if (a.type === 'name') name = (await r.read(a.start + 4, Math.min(a.end - a.start - 4, 256))).toString('utf8');
      if (a.type !== 'data') continue;
      const type = (await r.read(a.start, 4)).readUInt32BE(0) & 0xffffff;
      const len = a.end - a.start - 8;
      const key = MP4_KEYS[id];
      if (id === '----' && name) id = name;
      if (type === 13 || type === 14 || type === 27 || id === 'covr') {
        if (id === 'covr') tags.addPicture(await r.read(a.start + 8, Math.min(len, MAX_PICTURE)));
        tags.add(id, key, `${type === 14 ? 'image/png' : 'image/jpeg'}, ${kb(len)}`);
        continue;
      }
      const d = await r.read(a.start + 8, Math.min(len, MAX_VALUE * 4));
      if (id === 'trkn' || id === 'disk') {
        if (d.length >= 6) tags.add(id, key, d.readUInt16BE(2) + (d.readUInt16BE(4) ? '/' + d.readUInt16BE(4) : ''));
      } else if (id === 'gnre') {
        if (d.length >= 2) tags.add(id, key, GENRES[d.readUInt16BE(0) - 1] || String(d.readUInt16BE(0)));
      } else if (type === 21 || type === 22 || (type === 0 && d.length <= 8 && id !== '----')) {
        tags.add(id, key, String(d.length ? d.readUIntBE(0, Math.min(6, d.length)) : ''));
      } else {
        tags.add(id, key, d.toString('utf8'));
      }
    }
  }
}

// ---------- RIFF (WAV) ----------

async function readRiff(r, tags) {
  for (let pos = 12; pos + 8 <= r.size;) {
    const h = await r.read(pos, 12);
    const id = h.toString('latin1', 0, 4), len = h.readUInt32LE(4);
    if (id === 'LIST' && h.toString('latin1', 8, 12) === 'INFO') {
      const b = await r.read(pos + 12, Math.min(len - 4, MAX_BLOCK));
      for (let o = 0; o + 8 <= b.length;) {
        const sid = b.toString('latin1', o, o + 4), slen = b.readUInt32LE(o + 4);
        tags.add(sid, RIFF_KEYS[sid], b.toString('utf8', o + 8, Math.min(b.length, o + 8 + slen)).replace(/\0.*$/s, ''));
        o += 8 + slen + (slen & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') {
      await readId3v2(r, tags, pos + 8);
    }
    pos += 8 + len + (len & 1);
  }
}

/** Everything read from the audio file at `file`: { format, tags: Tags }. */
async function read(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const r = new Reader(fh, (await fh.stat()).size);
    const tags = new Tags();
    const head = await r.read(0, 12);
    const magic = head.toString('latin1', 0, 4);
    let format;
    if (magic === 'RIFF' && head.toString('latin1', 8, 12) === 'WAVE') { format = 'WAV'; await readRiff(r, tags); }
    else if (magic === 'OggS') { format = 'Ogg'; await readOgg(r, tags); }
    else if (magic === 'fLaC') { format = 'FLAC'; await readFlac(r, tags, 0); }
    else if (head.toString('latin1', 4, 8) === 'ftyp') { format = 'MP4'; await readMp4(r, tags); }
    else {
      const id3 = await readId3v2(r, tags);
      if (id3 && (await r.read(id3, 4)).toString('latin1') === 'fLaC') { format = 'FLAC'; await readFlac(r, tags, id3); }
      else format = id3 ? 'ID3v2' : null;
      if (await readId3v1(r, tags, !tags.list.length)) format = format ? format + ' + ID3v1' : 'ID3v1';
    }
    return { format, tags };
  } finally {
    await fh.close();
  }
}

/** Tags of the audio file at `file`: { format, tags, cover }. */
async function readAudioTags(file) {
  const { format, tags } = await read(file);
  return { format, tags: tags.list, cover: !!tags.picture };
}

/** The embedded cover picture: { type, data }, or null. */
async function readAudioCover(file) {
  const p = (await read(file)).tags.picture;
  return p ? { type: p.type, data: p.data } : null;
}

module.exports = { readAudioTags, readAudioCover };
