#!/bin/bash
# Restart the herdr server so it runs the installed binary's version, then bring every session back (D-50).
# Runs outside herdr (launchctl submit), because stopping the server ends every pane, orch's own included.
#   scripts/herdr-restart.sh --dry      print what it would do, change nothing
#   scripts/herdr-restart.sh            wait for idle workers (until DEADLINE), restart, resume
# Log: ~/Library/Logs/orch.herdr-restart.log
set -u
ORCH=${ORCH_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
DEADLINE=${DEADLINE:-02:15}
# SETTLE_S and WAKE_S: seconds to let the server settle after stop and orch boot before its prompt (tests set 0).
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1
# node and npm from nvm's default, wherever it points.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
cd "$ORCH" || exit 1
say() { echo "$(date '+%F %T') $*"; }
run() { if [ $DRY = 1 ]; then say "would run: $*"; else "$@"; fi; }
done_() { [ $DRY = 1 ] || launchctl remove orch.herdr-restart 2>/dev/null; exit "$1"; }

# orch's own session: ORCH_SID, else the agent in herdr's workspace labelled orch (sessions.json leaves orch out).
if [ -z "${ORCH_SID:-}" ]; then
  ws=$(herdr workspace list 2>/dev/null | python3 -c '
import json,sys
print(next((w["workspace_id"] for w in json.load(sys.stdin).get("result",{}).get("workspaces",[]) if w.get("label")=="orch"), ""))' 2>/dev/null)
  ORCH_SID=$(herdr agent list 2>/dev/null | python3 -c '
import json,sys
print(next(((a.get("agent_session") or {}).get("value","") for a in json.load(sys.stdin).get("result",{}).get("agents",[]) if a.get("workspace_id")==sys.argv[1]), ""))' "$ws" 2>/dev/null)
fi
[ -n "$ORCH_SID" ] || { say "no orch session found (no agent in a workspace labelled orch); set ORCH_SID"; done_ 3; }

# Agents working right now, other than orch's own pane.
working() {
  herdr agent list 2>/dev/null | python3 -c '
import json,sys
d=json.load(sys.stdin); a=d.get("result",{}).get("agents",[])
print(sum(1 for x in a if x.get("agent_status")=="working" and (x.get("agent_session") or {}).get("value")!=sys.argv[1]))' "$ORCH_SID"
}

# 0. Start no earlier than START (local time, after midnight); never in the daytime.
START=${START:-00:30}
if [ $DRY = 0 ]; then
  until [ "$(date +%H:%M)" \> "$START" ] && [ "$(date +%H:%M)" \< "$DEADLINE" ]; do sleep 300; done
  say "starting: waiting for idle workers until $DEADLINE"
fi

# 1. Wait for idle workers, at most until DEADLINE (local time); past it, give up for tonight.
while :; do
  n=$(working); [ -z "$n" ] && n=99
  [ "$n" = 0 ] && break
  [ $DRY = 1 ] && { say "dry: $n agents working now; a real run would wait"; break; }
  [ "$(date +%H:%M)" \> "$DEADLINE" ] && [ "$(date +%H:%M)" \< "12:00" ] && { say "still $n working at $DEADLINE: no restart tonight"; done_ 2; }
  sleep 120
done

# 2. What runs now, so it can be resumed: every live agent session with its cwd.
snap=$(herdr agent list 2>/dev/null | python3 -c '
import json,sys
for x in json.load(sys.stdin).get("result",{}).get("agents",[]):
  sid=(x.get("agent_session") or {}).get("value") or ""; cwd=x.get("cwd") or ""
  kind=x.get("agent") or "claude"; name=x.get("name") or ""
  if sid and cwd: print(sid, kind, cwd, name, sep="\t")')
say "sessions to bring back:"; echo "$snap" | sed 's/^/  /'
[ -n "$snap" ] || { say "no sessions found, aborting"; done_ 3; }
# A live agent without a session id could not be resumed; stop before the server goes down.
lost=$(herdr agent list 2>/dev/null | python3 -c '
import json,sys
for x in json.load(sys.stdin).get("result",{}).get("agents",[]):
  if not (x.get("agent_session") or {}).get("value"): print(x.get("name") or x.get("pane_id"), x.get("agent") or "?", x.get("cwd") or "")')
[ -z "$lost" ] || { say "aborting, these agents have no session id and would be lost:"; echo "$lost" | sed 's/^/  /'; done_ 5; }

# 3. Restart the server.
if ! out=$(run herdr server stop 2>&1); then say "herdr server stop failed, nothing restarted: $out"; done_ 6; fi
[ -n "$out" ] && say "$out"
[ $DRY = 1 ] || sleep "${SETTLE_S:-5}"
run sh -c 'nohup herdr server >/dev/null 2>&1 &'
if [ $DRY = 0 ]; then
  for i in $(seq 1 30); do herdr workspace list >/dev/null 2>&1 && break; sleep 2; done
  herdr workspace list >/dev/null 2>&1 || { say "herdr server did not come back"; done_ 4; }
  say "server up: $(herdr --version)"
fi

# 4. Bring each session back in its own workspace, orch first. Its only stdout is the new pane; everything it says,
# errors included, goes to stderr (the log).
resume() { # sid kind cwd name
  local sid=$1 kind=$2 cwd=$3 name=$4 cmd ws pane out
  if [ "$sid" = "$ORCH_SID" ]; then cmd="claude --resume $sid -n orch --remote-control orch --plugin-dir ./mod"
  elif [ "$kind" = codex ]; then cmd="codex resume $sid"
  else cmd="claude --resume $sid"; fi
  if [ $DRY = 1 ]; then say "would open $cwd (${name:-session}) and run: $cmd" >&2; return; fi
  ws=$(herdr workspace create --cwd "$cwd" --label "${name:-$(basename "$cwd")}" --no-focus 2>&1)
  pane=$(echo "$ws" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])' 2>/dev/null)
  [ -n "$pane" ] || { say "could not open a pane for ${name:-$sid} in $cwd: $ws" >&2; return 1; }
  out=$(herdr pane run "$pane" "$cmd" 2>&1) || { say "could not start ${name:-$sid} in $pane: $out" >&2; return 1; }
  say "resumed ${name:-$sid} in $pane" >&2
  echo "$pane"
}
orch_pane=""
# Every command in these loops reads /dev/null, so none of them eats the rest of the session list from stdin.
while IFS=$'\t' read -r sid kind cwd name; do
  [ "$sid" = "$ORCH_SID" ] && orch_pane=$(resume "$sid" "$kind" "$cwd" orch </dev/null | tail -1)
done <<< "$snap"
[ -n "$orch_pane" ] || [ $DRY = 1 ] || { orch_pane=$(resume "$ORCH_SID" claude "$ORCH" orch </dev/null | tail -1); }
# Leads (herdr agents named lead-<name>) are not resumed here: orch brings them back with lead start once its
# workers.json panes are right again (the prompt below).
leads=""
while IFS=$'\t' read -r sid kind cwd name; do
  [ "$sid" = "$ORCH_SID" ] && continue
  case "$name" in
    lead-*) leads="$leads ${name#lead-}" ;;
    *) resume "$sid" "$kind" "$cwd" "$name" </dev/null >/dev/null ;;
  esac
done <<< "$snap"

# 5. Tell orch it came back.
msg="The herdr server was restarted for D-50 and this session resumed. Re-arm the watcher, run npm run -s orch -- restore and the board, check every worker came back, update each worker's pane and workspace in workers.json from herdr agent list (the panes are new), and note the result in log.md and D-50."
for l in $leads; do msg="$msg Only after workers.json is updated, run npm run -s orch -- lead start $l and check lead status $l says its watcher is up."; done
if [ $DRY = 1 ]; then say "would prompt orch: $msg"; else
  sleep "${WAKE_S:-20}"
  herdr agent prompt "$orch_pane" "$msg" --wait --timeout 120000 >/dev/null 2>&1 || say "prompt to orch did not land; resume it by hand: cd $ORCH && claude --resume $ORCH_SID"
fi
say "done"; done_ 0
