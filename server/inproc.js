'use strict';
/**
 * Requests to the wrapper's routes without HTTP: the VS Code extension runs the server's code in its
 * own process and calls the same handler (server.js handleRequest) with a request and a response
 * that only look like Node's http ones. The response is a Writable whose head, chunks and end go to
 * a sink — the chat webview's fetch shim (a streamed NDJSON chat answer included) or a JSON reader
 * for the extension's own calls.
 *
 *   const { abort } = request(handler, { method, url, headers, body }, { head(status, headers), chunk(buf), end() });
 *   const json = await call(handler, 'GET', '/api/projects');   // rejects with Error(message) + status
 */
const { Readable, Writable } = require('stream');

/**
 * Runs one request. `body`: a string, a Buffer / Uint8Array, or null. abort() ends the response as
 * a closed connection does (the chat route then ends its claude run).
 */
function request(handler, { method = 'GET', url, headers = {}, body = null }, sink) {
  const data = body == null ? [] : [typeof body === 'string' ? Buffer.from(body) : Buffer.from(body.buffer ? body : Object.values(body))];
  const req = Readable.from(data);
  const lower = {};
  for (const [k, v] of Object.entries(headers || {})) lower[k.toLowerCase()] = v;
  Object.assign(req, { method, url, headers: lower, inproc: true });

  const sent = {};
  let headed = false;
  const res = new Writable({
    write(chunk, enc, cb) { head(); sink.chunk(Buffer.from(chunk, enc)); cb(); },
    final(cb) { head(); sink.end(); cb(); },
  });
  function head() {
    if (headed) return;
    headed = true;
    res.headersSent = true;
    sink.head(res.statusCode, sent);
  }
  Object.assign(res, {
    statusCode: 200,
    headersSent: false,
    setHeader(k, v) { sent[k.toLowerCase()] = v; return res; },
    getHeader(k) { return sent[k.toLowerCase()]; },
    removeHeader(k) { delete sent[k.toLowerCase()]; },
    writeHead(status, a, b) {
      res.statusCode = status;
      const h = a && typeof a === 'object' ? a : b;
      if (h) for (const [k, v] of Object.entries(h)) sent[k.toLowerCase()] = v;
      head();
      return res;
    },
    flushHeaders: head,
  });
  handler(req, res);
  return { abort: () => { if (!res.writableFinished) res.destroy(); } };
}

/** A request whose answer is JSON: resolves to it, or rejects with { message: its error, status }. */
function call(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const chunks = [];
    request(handler, {
      method, url,
      headers: body == null ? {} : { 'content-type': 'application/json' },
      body: body == null ? null : JSON.stringify(body),
    }, {
      head(s) { status = s; },
      chunk(buf) { chunks.push(buf); },
      end() {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (status >= 400) reject(Object.assign(new Error(json?.error || `HTTP ${status}`), { status }));
        else resolve(json);
      },
    });
  });
}

module.exports = { request, call };
