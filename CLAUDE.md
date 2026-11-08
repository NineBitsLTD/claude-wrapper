# CLAUDE.md

Claude Wrapper — a VS Code extension (macOS only) around a copy of Claude-AI's wrapper server
(`/Volumes/Projects/ninebits/claude-ai/server`). The copy is independent now; port fixes by hand.

## Layout

- `extension.js` — the whole extension (plain JS, no build, no npm dependencies): runs the wrapper's
  code in its own process (no server, no port); the activity bar container `claudeWrapper`, titled
  Projects, with one webview view — the projects as its main list, then collapsible sections History,
  Processes, Subagents and MCP Servers (one view, so VS Code draws no sashes between them: the view has its own —
  drag a section's top border, double-click for the default shares, heights remembered; rows of two
  or three lines; header toggles for finished entries and all
  projects; a click on a process, a subagent or an MCP server opens its details in an editor preview;
  MCP servers come from the chat's running Claude process and are managed there, otherwise the last
  list seen is shown and can be checked); the chat webview `claudeWrapper.chat` in the secondary side
  bar (in VS Code its gear menu has no MCP part — that is the side bar's). While Claude works, the chat's Stop and a
  project switch ask first: stop now, ask Claude to finish (a wrap-up message), or cancel.
- `server/` — the wrapper's code (Node built-ins only), a copy of Claude-AI's server: routes for the
  chat page and the side bar (`server.js`), called in-process through `server/inproc.js`. Run on its
  own (`node server/server.js`, http://127.0.0.1:3000, `.env` from `config/env.example`) it serves the
  page to a browser — handy for working on the page. Left out of the copy: the test API
  (api-gateway), image generation and its MCP bridge, the Cloudflare tunnel, the terminal, the file
  translation, the vendored Monaco/xterm, the built-in Python voice (tts-local) and the Swift speech
  recognition (stt). The chat's voice comes from the VS Code extension TTS / STT Aloud
  (`ninebits.tts-stt-aloud`, its API) when it is installed: its voice, speed and volume; without it
  the page speaks with the system voice. The microphone is its recording and Whisper recognition
  (hidden without the extension, off while its STT is off); it queues the speaker and the microphone
  among the windows, so the chat's phrases wait for their turn, by priority (questions and permission
  requests first, then messages, then thinking; the same inside the chat's queue, voice `PRIORITY`);
  headphones or speakers come from macOS
  (`system_profiler`, extension.js `defaultAudioOutput`), as the webview gets no device names.
- `server/public/index.html` — the chat page. In the extension it is loaded right into the webview
  (extension.js chatHtml: a CSP with nonces, `window.CW` = { embed: 'vscode', cwd, lang }); there it
  hides everything but the chat column (VS Code has the explorer, editor, terminal) and moves the
  voice/microphone/settings buttons into the chat head after the permission mode; its speech and
  its microphone go through the extension to TTS / STT Aloud (extension.js `aloud`). While it
  speaks, a player over the message box goes by phrases, pauses and stops; thinking is read as it
  comes in, sentence by sentence; a speaker on the message or thinking block under the pointer reads
  that one aloud. A click on an image of the chat or of
  the message being written opens it in VS Code's image viewer (a temporary file, extension.js `openImage`).
  With the Translator extension (`ninebits.translator`, its API; extension.js `translator`) a button
  before the speaker's turns translation on and chooses the language (VS Code's or one of the list):
  Claude's messages and thinking are shown and spoken translated, the original a click away (the
  thinking as it comes in, sentence by sentence; a block from history when it is opened); the
  user's messages can go to Claude in English.
- `server/public/vscode-shim.js` — loaded first in the webview: the page's channel to the extension
  (`window.cwHost`) and its `fetch('/api/...')` bridge (messages to the extension, the answer streamed
  back), so the page's code works as it does over HTTP.
- `server/public/i18n.js` — the page's UI language: helpers and the Russian and Ukrainian dictionaries.
- `config/env.example` — settings for the standalone server only.
- `resources/icon.png` — the extension icon, built by `swift scripts/make-icon.swift` from
  `resources/icon-space.svg` (the picture of babylon-editor's and tts-stt-aloud's icons, label CLAUDE).
- `npm run pack` — the .vsix (`@vscode/vsce`, a dev dependency).
- `media/codicons/` — VS Code's icon font for the webview views (copied from the dev dependency
  `@vscode/codicons` by `npm run codicons`; CC-BY-4.0), so their icons and twisties match VS Code's trees.

## The wrapper's code in the extension host

VS Code's extension host is shared with other extensions, so the server's code touches nothing
process-wide there: no `.env`, no signal handlers, no `process.env` edits except `NINEBITS_DATA_DIR`
(its data dir: the extension's global storage). claude and what it runs get `cleanEnv()`
(server/processes.js): without `ELECTRON_RUN_AS_NODE`, `VSCODE_*`, `CLAUDECODE` / `CLAUDE_CODE_*` and
the wrapper's own variables. Every window runs its own copy: its chats' claude runs (they end with
their page or the window) and a process registry over the shared `<globalStorage>/.run/processes.json`
(merged on write). Logs go to the extension host's log.

The Processes list covers every Claude Code process on the machine, whoever started it: each one
describes itself in `~/.claude/sessions/<pid>.json` (session, folder, name); `server/processes.js`
tracks them and their descendants, and keeps processes left behind by a finished session so they
can be stopped.

## Conventions

- UI language: English by default, Russian or Ukrainian when that is VS Code's display language.
  User-facing strings are English in the code with the translations next to them: the manifest in
  `package.nls.json` / `package.nls.ru.json` / `package.nls.uk.json`, `extension.js` through
  `vscode.l10n.t` with `l10n/bundle.l10n.ru.json` / `.uk.json`, the page through `tl()` / `tn()` with the dictionaries in
  `server/public/i18n.js` (the language comes in `window.CW.lang`; static markup is translated by
  `i18nDom`). Spoken phrases and their project prefixes follow the language of the message, not the
  UI's (`tlIn(lang, …)`, Russian and Ukrainian in the same file; a language without an entry falls
  back to the UI's, then English); a phrase with no words of its own (a command, a permission
  request) follows the language of the user's messages. The server's own messages are English; the page translates them with `tlMsg()`.
  A new string needs its Russian and Ukrainian entries in the matching files.
- Code comments and docs in English.
- Files start with a header comment describing their role — keep them current.
- No build step, no runtime npm dependencies.
