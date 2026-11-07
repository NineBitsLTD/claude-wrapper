# Claude Wrapper

A VS Code extension (macOS only): a chat with Claude Code through a wrapper around the `claude`
CLI — the server is copied from Claude-AI (`server/`). The UI is in English, or in Russian when
VS Code's display language is Russian.

- **Left** — the Claude Wrapper icon: the Projects view (a click opens the project's folder in VS
  Code; a project whose folder is gone asks for the new one and moves its history), History (the
  sessions of this window's folder; a click opens one in the chat), Processes (every Claude Code
  process on the machine and what it started, including processes left behind by finished
  sessions) and Subagents.
- **Right** — the chat in the secondary side bar, next to other chats.

One server per machine (`127.0.0.1:3210`, setting `claudeWrapper.port`), shared by all windows; it
keeps running after VS Code closes and is restarted on activation when its code has changed.
Commands: "Claude Wrapper: Restart Server", "Claude Wrapper: Server Log".

Needs the `claude` CLI on the PATH.

## Running from source

```bash
code --extensionDevelopmentPath=/Volumes/Projects/ninebits/vscode/claude-wrapper
```

## Packaging

```bash
npm install      # once: @vscode/vsce (a dev dependency; the extension itself has none)
npm run pack     # -> claude-wrapper-<version>.vsix
code --install-extension claude-wrapper-<version>.vsix
```
