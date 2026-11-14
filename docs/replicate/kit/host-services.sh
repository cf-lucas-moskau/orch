#!/bin/bash
# Agent host only. Installs two launchd jobs so the host comes back by itself after a reboot or power loss:
#   agent-host.herdr-server   keeps the herdr server running (KeepAlive)
#   agent-host.rc-bootstrap   every 5 min: makes sure herdr has a "remote-control" workspace running rc-loop.sh,
#                             which keeps `claude remote-control` up so you can start sessions from your phone.
# Safe to re-run. Usage: bash host-services.sh [--dry-run]
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
HERDR=$(command -v herdr) || { echo "herdr not installed (brew install herdr)"; exit 1; }
command -v claude >/dev/null || { echo "claude not installed"; exit 1; }
PATHS="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
run() { if [ $DRY = 1 ]; then echo "would run: $*"; else "$@"; fi; }

run mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$HOME/code"
run install -m 755 "$KIT/remote-control/rc-loop.sh" "$HOME/.local/bin/rc-loop.sh"
run install -m 755 "$KIT/remote-control/rc-bootstrap.sh" "$HOME/.local/bin/rc-bootstrap.sh"
plist() { # label, program-args xml, extra keys xml
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$2</array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATHS</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>TERM</key><string>xterm-256color</string>
  </dict>
  <key>WorkingDirectory</key><string>$HOME</string>
  $3
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$1.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$1.log</string>
</dict>
</plist>
EOF
}

load() { # label, plist text
  local dst="$HOME/Library/LaunchAgents/$1.plist"
  if [ $DRY = 1 ]; then
    local tmp; tmp=$(mktemp -t plist); printf '%s\n' "$2" > "$tmp"
    plutil -lint "$tmp" >/dev/null && echo "would write $dst (plist ok)"; rm -f "$tmp"; return
  fi
  printf '%s\n' "$2" > "$dst"
  plutil -lint "$dst" >/dev/null
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$dst"
  echo "loaded $1"
}

load agent-host.herdr-server "$(plist agent-host.herdr-server "<string>$HERDR</string><string>server</string>" \
  '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Interactive</string>')"
load agent-host.rc-bootstrap "$(plist agent-host.rc-bootstrap "<string>$HOME/.local/bin/rc-bootstrap.sh</string>" \
  '<key>RunAtLoad</key><true/><key>StartInterval</key><integer>300</integer>')"