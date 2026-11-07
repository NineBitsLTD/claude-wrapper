#!/bin/sh
# Shell prefix for Claude Code (CLAUDE_CODE_SHELL_PREFIX), set by the web wrapper.
#
# Claude Code runs every shell command (Bash tool, hooks, stdio MCP servers) as:
#   track-shell.sh '<command string>'
# This script appends "pid pgid ppid epoch runId" to the journal and then runs the command.
# The process group is what lets the wrapper attribute jobs detached with `&` / `nohup`
# that outlive this shell and get reparented to PID 1.

if [ -n "$CLAUDE_WEB_JOURNAL" ]; then
  pgid=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  printf '%s %s %s %s %s\n' "$$" "${pgid:-0}" "$PPID" "$(date +%s)" "${CLAUDE_WEB_RUN_ID:--}" \
    >> "$CLAUDE_WEB_JOURNAL" 2>/dev/null
fi

# Chain a prefix the user had configured before the wrapper took the variable over.
if [ -n "$CLAUDE_WEB_ORIG_PREFIX" ]; then
  exec "$CLAUDE_WEB_ORIG_PREFIX" "$@"
fi

# Normally a single command string; several arguments are executed as argv.
if [ $# -gt 1 ]; then
  exec "$@"
fi
exec "${SHELL:-/bin/sh}" -c "$1"
