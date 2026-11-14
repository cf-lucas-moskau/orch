#!/bin/bash
# Installs pstack (poteto-mode, which every orch Claude worker starts in) and pstack-team-kit (deslop, control-cli,
# control-ui, which poteto-mode calls) from the public Claude Code port github.com/cf-lucas-moskau/pstack-claude.
# Writes a default ~/.claude/pstack/models.md when there is none (never overwrites); /pstack:setup-pstack changes it.
# Safe to re-run. Afterwards restart Claude so the plugins load.
# Usage: bash pstack.sh            CLAUDE_CONFIG_DIR is honoured, so a test can run against a scratch config.
set -euo pipefail
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
claude plugin marketplace list --json 2>/dev/null | grep -q '"name": "pstack-claude"' \
  || claude plugin marketplace add cf-lucas-moskau/pstack-claude
claude plugin marketplace update pstack-claude >/dev/null 2>&1 || true
for p in pstack pstack-team-kit; do
  claude plugin list --json 2>/dev/null | grep -q "\"id\": \"$p@pstack-claude\"" || claude plugin install "$p@pstack-claude"
done
ls "$CFG"/plugins/cache/*/pstack/*/skills/poteto-mode/SKILL.md >/dev/null
# A default model per role (Opus for code and judgment, Sonnet for bulk exploration), only when none exists yet.
mkdir -p "$CFG/pstack"
[ -f "$CFG/pstack/models.md" ] || cp "$(dirname "$0")/../templates/pstack-models.md" "$CFG/pstack/models.md"
echo "pstack and pstack-team-kit installed, models in $CFG/pstack/models.md; restart Claude (/pstack:setup-pstack changes the models)"
