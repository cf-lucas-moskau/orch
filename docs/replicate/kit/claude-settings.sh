#!/bin/bash
# Run on the host; ~/.claude syncs to main. Merges what unattended agents need into ~/.claude/settings.json and
# installs the status line and the media-relay hooks next to it. Keeps every other key. Safe to re-run.
#   permissions.defaultMode auto     workers and bus sessions act without a prompt nobody answers;
#   skipAutoPermissionPrompt          the classifier still reviews every action
#   remoteControlAtStartup            every session, workers included, is reachable from the Claude app
#   agentPushNotifEnabled             orch's PushNotification (a new decision, the morning brief) reaches the phone
#   statusLine                        model, 5-hour and weekly limit, session cost
#   hooks                             remote-paths.py (UserPromptSubmit), share-images.py (PostToolUse on Read)
# Usage: bash claude-settings.sh     CLAUDE_CONFIG_DIR is honoured, so a test can run against a scratch config.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
S="$CFG/settings.json"
mkdir -p "$CFG/hooks"
install -m 755 "$KIT/statusline.sh" "$CFG/statusline.sh"
install -m 755 "$KIT/media-relay/remote-paths.py" "$KIT/media-relay/share-images.py" "$CFG/hooks/"
[ -s "$S" ] || echo '{}' > "$S"
cp "$S" "$S.bak-agent-setup"

# Paths stay $HOME-relative so the synced file works on both Macs.
RP='/usr/bin/python3 "$HOME/.claude/hooks/remote-paths.py"'
SI='/usr/bin/python3 "$HOME/.claude/hooks/share-images.py"'
SL='bash "$HOME/.claude/statusline.sh"'
tmp=$(mktemp)
jq --arg rp "$RP" --arg si "$SI" --arg sl "$SL" '
  def addhook(ev; matcher; cmd; t):
    if ([.hooks[ev][]?.hooks[]?.command] | index(cmd)) then .
    else .hooks[ev] += [({hooks: [{type: "command", command: cmd, timeout: t}]} + (if matcher then {matcher: matcher} else {} end))] end;
  .permissions.defaultMode = "auto"
  | .skipAutoPermissionPrompt = true
  | .remoteControlAtStartup = true
  | .agentPushNotifEnabled = true
  | .statusLine = {type: "command", command: $sl}
  | addhook("UserPromptSubmit"; null; $rp; 25)
  | addhook("PostToolUse"; "Read"; $si; 10)
' "$S" > "$tmp"
mv "$tmp" "$S"
echo "settings merged into $S (backup: $S.bak-agent-setup)"
