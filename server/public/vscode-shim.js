/**
 * Claude Wrapper — the chat page's bridge to the VS Code extension, loaded before the page's own
 * scripts when the extension shows the page in its webview (not in a browser).
 *
 * - window.CW: what a browser would read from the URL ({ embed: 'vscode', cwd, lang }), set by the
 *   extension in an inline script before this one.
 * - window.cwHost: the webview's channel to the extension (acquireVsCodeApi() may be called once).
 * - fetch('/api/...'): there is no HTTP server — the extension runs the server's code itself. The
 *   request goes to it as a message { type: 'http', id, method, url, headers, body } and the answer
 *   comes back as { type: 'http', id, phase: 'head' | 'chunk' (chunk: text, or b64) | 'end' | 'error' } into a streamed
 *   Response, so the page's code (the NDJSON chat stream included) works unchanged; aborting the
 *   request's signal sends { type: 'httpAbort', id } (the chat route then ends its claude run).
 *   Other URLs go to the real fetch.
 */
'use strict';
(() => {
  const host = acquireVsCodeApi();
  window.cwHost = host;
  const realFetch = window.fetch.bind(window);
  const pending = new Map(); // id -> { resolve, reject, controller, stream }
  let seq = 0;
  const encoder = new TextEncoder();

  const own = (url) => /^\/(api\/|i18n\.js)/.test(url);

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : input.url;
    if (!own(url)) return realFetch(input, init);
    let body = init.body ?? null;
    if (body != null && typeof body !== 'string') body = new Uint8Array(await new Response(body).arrayBuffer());
    const headers = init.headers instanceof Headers ? Object.fromEntries(init.headers) : { ...(init.headers || {}) };
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('The user aborted a request.', 'AbortError');
    const id = ++seq;
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject, controller, stream }));
    signal?.addEventListener('abort', () => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      host.postMessage({ type: 'httpAbort', id });
      const err = new DOMException('The user aborted a request.', 'AbortError');
      p.reject(err);
      try { p.controller.error(err); } catch {}
    });
    host.postMessage({ type: 'http', id, method: (init.method || 'GET').toUpperCase(), url, headers, body });
    return answer;
  };

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m?.type !== 'http') return;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.phase === 'head') {
      const empty = m.status === 204 || m.status === 304;
      p.resolve(new Response(empty ? null : p.stream, { status: m.status, headers: m.headers || {} }));
    } else if (m.phase === 'chunk') {
      // Text comes as text, anything else as base64.
      p.controller.enqueue(m.b64 != null ? Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0)) : encoder.encode(m.chunk));
    } else if (m.phase === 'end') {
      pending.delete(m.id);
      try { p.controller.close(); } catch {}
    } else if (m.phase === 'error') {
      pending.delete(m.id);
      const err = new TypeError(m.message || 'Failed to fetch');
      p.reject(err);
      try { p.controller.error(err); } catch {}
    }
  });

  // A reloaded page: the extension ends what the previous one left open.
  host.postMessage({ type: 'httpReset' });
})();
