#!/bin/bash
# Keeps `claude remote-control` (server mode) alive inside a herdr pane, so the Claude app on your phone
# or claude.ai/code can start new sessions on this Mac in ~/code.
cd "$HOME/code" || exit 1
prefix=$(~/.claude/agent-bus/bin/bus whoami 2>/dev/null || hostname -s)
while true; do
  claude remote-control --spawn same-dir --remote-control-session-name-prefix "$prefix"
  echo "remote-control exited at $(date), restarting in 10s"
  sleep 10
done
