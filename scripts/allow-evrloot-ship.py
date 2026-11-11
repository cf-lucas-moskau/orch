#!/usr/bin/env python3
"""Add Lucas's standing auto-mode approval for orch's evrloot merges and deploys to ~/.claude/settings.json.
Run once by Lucas (orch may not edit its own permission settings): python3 scripts/allow-evrloot-ship.py"""
import json, os

p = os.path.expanduser('~/.claude/settings.json')
d = json.load(open(p))
allow = d.setdefault('autoMode', {}).setdefault('allow', ['$defaults'])
rules = [
    "Evrloot deploys: orch (cwd /Users/lucas/orch) may run `npm run -s deploy:evrloot` whenever a merged evrloot-next PR "
    "is waiting to go live. The script backs up the database, refuses migration changes and deploys to Lucas's own alpha "
    "server on spare-mbp (127.0.0.1:8790 behind Tailscale). Lucas's standing approval (2026-11-10), not self-approval.",
    "Evrloot merges: orch may run `npm run -s orch -- merge evrloot-next <n>` for PRs in cf-lucas-moskau/evrloot-next that "
    "passed orch's gates and Claude+Codex review, including PRs orch's own workers pushed. Lucas's standing approval, "
    "not self-approval.",
    "orch merges: orch may run `npm run -s orch -- merge orch <n>` for PRs in cf-lucas-moskau/orch that passed orch's "
    "gates (npm test) and Claude+Codex review, including PRs orch or its workers pushed, and then run `npm run setup` in "
    "~/orch to install the hooks they add. Lucas's standing approval (2026-11-11: \"Add orch\"), not self-approval.",
]
added = [r for r in rules if r not in allow]
allow.extend(added)
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print(f'added {len(added)} rule(s); autoMode.allow now has {len(allow)} entries')
