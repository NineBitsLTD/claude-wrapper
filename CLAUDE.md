# CLAUDE.md

Claude Wrapper — a VS Code extension (macOS only) around a copy of Claude-AI's wrapper server
(`/Volumes/Projects/ninebits/claude-ai/server`). The copy is independent now; port fixes by hand.

## Layout

- `extension.js` — the whole extension (plain JS, no build, no npm dependencies): starts or attaches
  to the server; the views of the activity bar container `claudeWrapper`: Projects, History,
  Processes and Subagents (webview views with rows of two or three lines; Processes and
  Subagents have toggles for finished entries and all projects; a click on a process or a subagent
  opens its details in an editor preview); the chat webview `claudeWrapper.chat` in the secondary
  side bar. While Claude works, the chat's Stop and a project switch ask first: stop now, ask
  Claude to finish (a wrap-up message), or cancel.
- `server/` — the wrapper server (Node built-ins only). Left out of the copy: the test API
  (api-gateway), image generation and its MCP bridge, the Cloudflare tunnel, the terminal, the file
  translation, the vendored Monaco/xterm, the built-in Python voice (tts-local) and the Swift speech
  recognition (stt). Voice and recognition will come from a VS Code extension (tts-stt-md-aloud).
- `server/public/i18n.js` — the page's UI language: helpers and the Russian dictionary.
- `server/public/index.html` — the chat page; with `?embed=vscode&cwd=<folder>` (the webview's
  iframe) it hides everything but the chat column (VS Code has the explorer, editor, terminal), moves
  the voice/microphone/settings buttons into the chat head after the permission mode, and talks to the
  extension by postMessage (see the header of extension.js).
- `config/env.example` — copied to the data dir as `.env` on first start.
- `resources/icon.png` — the extension icon, built by `swift scripts/make-icon.swift` from
  `resources/icon-space.svg` (the picture of babylon-editor's and tts-stt-md-aloud's icons, label CLAUDE).
- `npm run pack` — the .vsix (`@vscode/vsce`, a dev dependency).

## Server

One per machine on `127.0.0.1:<claudeWrapper.port>` (3210, so it doesn't meet Claude-AI's 3000),
started detached with VS Code's Node (`process.execPath`, `ELECTRON_RUN_AS_NODE=1`, which the server
removes from its own env), data in the extension's global storage (`NINEBITS_DATA_DIR`). `/api/info`
answers `server: 'claude-wrapper'`, `version` (package.json) and `build` (a fingerprint of the
files in `server/`, server/build-id.js); a server of another version or build is restarted on
activation when no run is working, so edits to the server need only a window reload. Logs:
`<globalStorage>/server.log`.

The Processes list covers every Claude Code process on the machine, whoever started it: each one
describes itself in `~/.claude/sessions/<pid>.json` (session, folder, name); `server/processes.js`
tracks them and their descendants, and keeps processes left behind by a finished session so they
can be stopped.

## Conventions

- UI language: English by default, Russian when VS Code's display language is Russian. User-facing
  strings are English in the code with Russian translations next to them: the manifest in
  `package.nls.json` / `package.nls.ru.json`, `extension.js` through `vscode.l10n.t` with
  `l10n/bundle.l10n.ru.json`, the page through `tl()` / `tn()` with the dictionary in
  `server/public/i18n.js` (the extension passes `lang=` in the iframe URL; static markup is translated
  by `i18nDom`). The server's own messages are English; the page translates them with `tlMsg()`.
  A new string needs its Russian entry in the matching file.
- Code comments and docs in English.
- Files start with a header comment describing their role — keep them current.
- No build step, no runtime npm dependencies.
