#!/bin/bash
# Read-only status of this Mac's agent setup. Changes nothing.
# Usage: bash check.sh host|main     (host = the always-on agent Mac, main = the Mac you work on)
# Prints one line per check (ok / MISSING) and exits 1 if anything a role needs is missing.
role="${1:-}"
case "$role" in host|main) ;; *) echo "usage: bash check.sh host|main"; exit 2 ;; esac
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
fail=0
ok()   { printf '  ok       %s\n' "$1"; }
miss() { printf '  MISSING  %s\n' "$1"; fail=1; }
info() { printf '  ·        %s\n' "$1"; }
chk()  { local label="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$label"; else miss "$label"; fi; }
has()  { command -v "$1" >/dev/null 2>&1; }
job()  { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
ORCH="${ORCH_DIR:-$HOME/orch}"

echo "Machine"
info "macOS $(sw_vers -productVersion), user $(whoami)"
chk "FileVault on" sh -c 'fdesetup status | grep -q "FileVault is On"'
chk "Remote Login (SSH) listening" nc -z -G 2 127.0.0.1 22
if [ "$role" = host ]; then
  chk "Screen Sharing listening" nc -z -G 2 127.0.0.1 5900
  chk "system sleep off (pmset sleep 0)" sh -c 'pmset -g | grep -Eq "^ *sleep +0"'
fi

echo "Tools"
for t in brew git gh jq node npm claude herdr syncthing tailscale; do chk "$t" has "$t"; done
chk "node 22.6+" node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)'
chk "python3" has python3
chk "Google Chrome (Playwright MCP)" test -d "/Applications/Google Chrome.app"
if [ "$role" = host ]; then
  has pdftoppm && ok "poppler" || miss "poppler (brew install poppler)"
  if has codex; then
    ok "codex (optional)"
    chk "codex trusts orch's hooks" grep -q 'hooks.json:session_start' "$HOME/.codex/config.toml"
  else info "codex not installed (optional)"; fi
  if has docker; then chk "docker running (optional)" docker info; else info "docker not installed (optional, only for repos that need it)"; fi
fi
chk "gh logged in" gh auth status
chk "claude logged in" sh -c 'claude auth status 2>/dev/null | grep -qi "logged in\|\"loggedIn\": *true"'

echo "Tailscale"
chk "tailscale running" sh -c 'tailscale status --json | grep -q "\"BackendState\": *\"Running\""'
name=$(tailscale status --self --json 2>/dev/null | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].split(".")[0])' 2>/dev/null)
[ -n "$name" ] && info "tailnet name: $name" || miss "tailnet name"

echo "Syncthing"
chk "syncthing GUI/API answers on 127.0.0.1:8384" curl -s -o /dev/null http://127.0.0.1:8384/
ST=""
for f in "$HOME/Library/Application Support/Syncthing/config.xml" "$HOME/.local/state/syncthing/config.xml" "$HOME/.config/syncthing/config.xml"; do [ -f "$f" ] && ST="$f" && break; done
if [ -n "$ST" ]; then
  for id in claude-config agent-bus agent-outbox vault screenshots agent-images; do chk "folder $id" grep -q "<folder id=\"$id\"" "$ST"; done
  chk "discovery and relays off (Tailscale only)" sh -c "grep -q '<globalAnnounceEnabled>false' '$ST' && grep -q '<relaysEnabled>false' '$ST'"
else miss "syncthing config.xml"; fi

echo "agent-bus"
BUS="$HOME/.claude/agent-bus/bin/bus"
chk "bus installed" test -x "$BUS"
chk "signing key" test -f "$HOME/.config/agent-bus/id_ed25519"
chk "trusts at least one other machine" test -s "$HOME/.config/agent-bus/allowed_signers"
chk "watcher job agent-bus.watch loaded" job agent-bus.watch
chk "agent-bus skill" test -f "$HOME/.claude/skills/agent-bus/SKILL.md"

echo "Claude config"
chk "user CLAUDE.md" test -f "$HOME/.claude/CLAUDE.md"
chk "image-gen skill" test -f "$HOME/.claude/skills/image-gen/SKILL.md"
chk "image-gen key (.env)" test -f "$HOME/.claude/skills/image-gen/.env"
chk "present skill" sh -c 'ls "$HOME"/.claude/skills/present/*.md'
chk "Playwright MCP configured" sh -c 'grep -q "@playwright/mcp" "$HOME/.claude.json"'
chk "herdr claude integration" sh -c 'herdr integration status | grep -q "^claude: current"'
plugins=$(claude plugin list --json 2>/dev/null)
for p in pstack pstack-team-kit; do
  chk "$p plugin enabled" sh -c 'printf "%s" "$0" | jq -e --arg p "$1" "any(.[]; (.id | startswith(\$p + \"@\")) and .enabled)"' "$plugins" "$p"
done
chk "poteto-mode skill present" sh -c 'ls "$HOME"/.claude/plugins/cache/*/pstack/*/skills/poteto-mode/SKILL.md'
chk "pstack models (~/.claude/pstack/models.md)" test -f "$HOME/.claude/pstack/models.md"
S="$HOME/.claude/settings.json"
chk "auto mode for unattended agents" jq -e '.permissions.defaultMode == "auto" and .skipAutoPermissionPrompt == true' "$S"
chk "Remote Control at startup" jq -e '.remoteControlAtStartup == true' "$S"
chk "push notifications" jq -e '.agentPushNotifEnabled == true' "$S"
chk "status line" jq -e '.statusLine.command' "$S"
chk "media-relay hooks" sh -c 'test -f "$HOME/.claude/hooks/remote-paths.py" && test -f "$HOME/.claude/hooks/share-images.py" && grep -q remote-paths.py "$0" && grep -q share-images.py "$0"' "$S"
if [ "$role" = host ]; then
  chk "agent-images sender marker" test -f "$HOME/.config/agent-images/sender"
else
  chk "screenshots go to ~/Screenshots" sh -c '[ "$(defaults read com.apple.screencapture location 2>/dev/null)" = "$HOME/Screenshots" ]'
  chk "screenshot catcher job" job agent-main.screenshot-catcher
fi

if [ "$role" = host ]; then
  echo "Agent host services"
  chk "herdr server running" sh -c 'herdr status server | grep -q "status: running"'
  chk "job agent-host.herdr-server" job agent-host.herdr-server
  chk "job agent-host.rc-bootstrap" job agent-host.rc-bootstrap
  chk "deck-to-pdf installed" test -d "$HOME/.local/share/deck-to-pdf/node_modules/playwright-core"
  echo "orch"
  chk "repo at $ORCH" test -f "$ORCH/package.json"
  chk "local.md" test -f "$ORCH/local.md"
  chk "projects.md" test -f "$ORCH/projects.md"
  chk "feed hook in ~/.claude/settings.json" grep -q orch-feed.sh "$HOME/.claude/settings.json"
  chk "routine scheduler job orch.routines" job orch.routines
  chk "feed written today" test -s "$ORCH/feed/$(date +%F).jsonl"
  chk "herdr workspace orch" sh -c 'herdr workspace list | grep -q "\"label\":\"orch\""'
  chk "decision queue page on :${ORCH_QUEUE_PORT:-7390}" nc -z -G 2 127.0.0.1 "${ORCH_QUEUE_PORT:-7390}"
  chk "morning-brief routine" test -f "$ORCH/routines/morning-brief.md"
fi

echo
if [ $fail = 0 ]; then echo "All checks passed for role $role."; else echo "Some checks are MISSING (see above)."; fi
exit $fail
