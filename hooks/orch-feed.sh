#!/bin/bash
# Appends one line per Claude Code hook event to $ORCH_DIR/feed for orch to read (npm run setup installs it).
# Codex runs it too (ORCH_AGENT=codex in ~/.codex/hooks.json); its PermissionRequest is logged as Notification.
# Must never block or fail the session: no orch dir means no-op, errors are swallowed, always exit 0.
dir="${ORCH_DIR:-$HOME/orch}"
[ -d "$dir" ] || exit 0
in=$(cat)
{
  mkdir -p "$dir/feed"
  ev=$(printf '%s' "$in" | jq -r '.hook_event_name // empty')
  tp=$(printf '%s' "$in" | jq -r '.transcript_path // empty')
  last=""
  if [ "$ev" = Stop ] && [ -f "$tp" ]; then
    last=$(tail -n 80 "$tp" | jq -rs '[.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text] | last // ""')
  fi
  printf '%s' "$in" | jq -c --arg ts "$(date -u +%FT%TZ)" --arg last "$last" --arg agent "${ORCH_AGENT:-claude}" '
  if .hook_event_name == "PermissionRequest" then
    .hook_event_name = "Notification" | .message = "Codex needs your permission: " + (.tool_input.description // .tool_name // "")
  else . end | {
    ts: $ts, sid: .session_id, event: .hook_event_name, cwd: .cwd, agent: $agent,
    prompt: ((.prompt // "") | split("\n")[0] | .[0:300]),
    msg: ((.last_assistant_message // (if $last == "" then null else $last end) // .message // "") | .[0:400]),
    tail: ((.last_assistant_message // (if $last == "" then null else $last end) // .message // "") | .[-300:])
  }' >> "$dir/feed/$(date +%F).jsonl"
} 2>/dev/null
exit 0
