#!/bin/bash
# Run by launchd at login and every 5 min: wait for the herdr server, then make sure the herdr workspace
# "remote-control" exists and its pane runs rc-loop.sh.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
for _ in $(seq 1 60); do herdr status server 2>/dev/null | grep -q "status: running" && break; sleep 2; done
ws=$(herdr workspace list 2>/dev/null | python3 -c '
import json,sys
print(next((w["workspace_id"] for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="remote-control"), ""))')
if [ -n "$ws" ]; then
  pane=$(herdr pane list | python3 -c '
import json,sys
print(next(p["pane_id"] for p in json.load(sys.stdin)["result"]["panes"] if p["workspace_id"]==sys.argv[1]))' "$ws")
  herdr pane process-info --pane "$pane" 2>/dev/null | grep -q claude && exit 0
else
  pane=$(herdr workspace create --cwd "$HOME/code" --label remote-control --no-focus | python3 -c '
import json,sys
print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
fi
sleep 2
herdr pane run "$pane" "$HOME/.local/bin/rc-loop.sh"
