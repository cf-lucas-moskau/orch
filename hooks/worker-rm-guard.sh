#!/bin/bash
# PreToolUse hook orch passes to its Claude workers (D-119, 25.11.): an rm whose path holds a shell variable or command
# substitution is refused at once with a reason, instead of waiting on a permission prompt nobody answers.
input=$(cat)
cmd=$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("tool_input",{}).get("command",""))
except Exception: pass')
if printf '%s' "$cmd" | grep -Eq '(^|[;&|(`[:space:]])rm[[:space:]]+[^;&|]*(\$|`)'; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"orch: rm with a variable or command substitution in its path is refused (D-119). Write the literal path, check it exists, then rm it."}}'
fi
exit 0
