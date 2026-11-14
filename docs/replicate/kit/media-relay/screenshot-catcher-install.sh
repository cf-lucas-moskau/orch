#!/bin/bash
# Main Mac only: screenshots go to ~/Screenshots, and a launchd agent copies ones dragged from the floating
# thumbnail there too, so a screenshot pasted into a host session is found by remote-paths.py. Safe to re-run.
# PREFIX and NOLOAD exist only for testing.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
label=agent-main.screenshot-catcher
bin=${PREFIX:-$HOME}/.local/bin/screenshot-catcher
plist=${PREFIX:-$HOME}/Library/LaunchAgents/$label.plist

mkdir -p "$(dirname "$bin")" "$(dirname "$plist")" "$HOME/Screenshots"
swiftc -O "$here/screenshot-catcher.swift" -o "$bin"
grep -qxF '.part-*' "$HOME/Screenshots/.stignore" 2>/dev/null || echo '.part-*' >> "$HOME/Screenshots/.stignore"

printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
  '<plist version="1.0">' '<dict>' \
  "  <key>Label</key><string>$label</string>" \
  "  <key>ProgramArguments</key><array><string>$bin</string></array>" \
  '  <key>RunAtLoad</key><true/>' '  <key>KeepAlive</key><true/>' \
  "  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$label.log</string>" \
  '</dict>' '</plist>' > "$plist"
plutil -lint "$plist" >/dev/null
[ -n "${NOLOAD:-}" ] && { echo "built $bin, wrote $plist"; exit 0; }

defaults write com.apple.screencapture location "$HOME/Screenshots"
defaults write com.apple.screencapture show-thumbnail -bool true
killall SystemUIServer 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"

if "$bin" --check >/dev/null 2>&1; then
  echo "Done. Screenshot catcher is running."
else
  echo "Almost done: grant Full Disk Access to $bin"
  echo "System Settings opens now. Click +, press Cmd+Shift+G, paste the path above, add it, switch it on."
  echo "Then run: launchctl kickstart -k gui/$(id -u)/$label"
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
fi
