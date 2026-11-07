# Claude Wrapper

A VS Code extension (macOS only): a chat with Claude Code through a wrapper around the `claude`
CLI, whose code is copied from Claude-AI's server (`server/`) and runs inside the extension. The UI is in English, or in Russian when
VS Code's display language is Russian.

- **Left** — the Projects icon: Claude Code's projects (a click opens the project's folder in VS
  Code; a project whose folder is gone asks for the new one and moves its history), and under them
  History (the sessions of this window's folder; a click opens one in the chat), Processes (every
  Claude Code process on the machine and what it started, including processes left behind by
  finished sessions), Subagents and MCP Servers (those of the chat's Claude process: sign in,
  reconnect, enable, disable while it runs; otherwise the last list seen, with a check).
- **Right** — the chat in the secondary side bar, next to other chats.

No server process and no port: the wrapper's code runs inside the extension.

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
