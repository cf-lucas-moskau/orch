#!/bin/bash
# Run by launchd (agent-host.orch-bootstrap) at login and every 5 min. Brings orch back after a reboot or a crash
# without anyone attaching to herdr: makes sure herdr's workspace "orch" runs a claude session in ~/orch, resuming
# orch's last conversation, and prompts it once so it re-arms its watcher (which also starts the queue page).
# While orch runs it only records orch's session id. Usage: orch-bootstrap.sh [--dry-run]
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
ORCH="${ORCH_DIR:-$HOME/orch}"
STATE="${ORCH_BOOTSTRAP_STATE:-$HOME/.cache/orch-bootstrap}"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
mkdir -p "$STATE"
say() { echo "$(date '+%F %T') $*"; }
[ -f "$ORCH/package.json" ] || { say "no orch at $ORCH"; exit 0; }

for _ in $(seq 1 60); do herdr status server 2>/dev/null | grep -q "status: running" && break; sleep 2; done
herdr status server 2>/dev/null | grep -q "status: running" || { say "herdr server not running"; exit 1; }

ws=$(herdr workspace list 2>/dev/null | python3 -c '
import json,sys
print(next((w["workspace_id"] for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="orch"), ""))')

# orch up: a claude agent in that workspace. Remember its session id for the next restart.
if [ -n "$ws" ]; then
  sid=$(herdr agent list 2>/dev/null | python3 -c '
import json,sys
a=[x for x in json.load(sys.stdin)["result"]["agents"] if x.get("workspace_id")==sys.argv[1] and x.get("agent")=="claude"]
print(((a[0].get("agent_session") or {}).get("value") or "-") if a else "")' "$ws")
  if [ -n "$sid" ]; then
    [ "$sid" != "-" ] && echo "$sid" > "$STATE/sid"
    rm -f "$STATE/pending"
    exit 0
  fi
fi

# A start in the last 5 minutes may still be loading; don't type into it.
if [ -f "$STATE/pending" ] && [ $(( $(date +%s) - $(cat "$STATE/pending") )) -lt 300 ]; then exit 0; fi
# The last start never came up: its session id may be gone, so fall back to the newest conversation.
[ -f "$STATE/pending" ] && { say "last start failed; dropping the saved session id"; rm -f "$STATE/sid" "$STATE/pending"; }

pane=""
if [ -n "$ws" ]; then
  pane=$(herdr pane list 2>/dev/null | python3 -c '
import json,sys
print(next((p["pane_id"] for p in json.load(sys.stdin)["result"]["panes"] if p["workspace_id"]==sys.argv[1]), ""))' "$ws")
  # Only type into a pane that sits at a shell prompt.
  fg=$([ -n "$pane" ] && herdr pane process-info --pane "$pane" 2>/dev/null | python3 -c '
import json,sys
ps=json.load(sys.stdin)["result"]["process_info"].get("foreground_processes",[])
text=" ".join((p.get("argv0") or "")+" "+(p.get("cmdline") or "") for p in ps)
names={(p.get("name") or "").lstrip("-") for p in ps}
print("claude" if "claude" in text or "npm" in text else "shell" if names <= {"zsh","bash","sh",""} else "other:"+",".join(sorted(names)))')
  case "$fg" in
    claude) exit 0 ;;   # claude (or npm start) is starting or running; herdr just hasn't detected it yet
    shell) ;;
    *) say "orch pane $pane runs ${fg#other:}; not touching it"; exit 0 ;;
  esac
fi
if [ -z "$pane" ]; then
  [ $DRY = 1 ] && { say "would create workspace orch and start orch"; exit 0; }
  pane=$(herdr workspace create --cwd "$ORCH" --label orch --no-focus | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
  sleep 2
fi

resume="--continue"
[ -s "$STATE/sid" ] && resume="--resume $(cat "$STATE/sid")"
args="-n orch --remote-control orch --plugin-dir ./mod"
# No conversation to resume (first start, or the id is gone): claude exits non-zero and a fresh orch starts.
cmd="cd '$ORCH' && { claude $resume $args || claude $args; }"
[ $DRY = 1 ] && { say "would run in $pane: $cmd"; exit 0; }
date +%s > "$STATE/pending"
herdr pane run "$pane" "$cmd"
say "started orch in $pane ($resume)"
sleep 25
msg="orch was restarted by orch-bootstrap (reboot or crash) and resumed this conversation. Re-arm the watcher as on session start, run npm run -s orch -- restore and resume what it lists, then the board, and note the result in log.md."
herdr agent prompt "$pane" "$msg" --wait --timeout 120000 >/dev/null 2>&1 \
  && say "prompted orch" || say "prompt to orch did not land; attach with herdr and say: re-arm the watcher"
