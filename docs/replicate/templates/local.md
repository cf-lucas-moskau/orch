# local

Overrides for this machine and user. Wins over `policies.md` and over the Lucas-specific parts of `CLAUDE.md`.

The user is {{OWNER}}. orch runs on {{AGENT_HOST}} (the always-on agent Mac) in the herdr workspace `orch`. {{OWNER}} works on {{MAIN_HOST}} and reaches orch through Remote Control (Claude app on the phone, claude.ai/code) or `herdr --remote {{USER}}@{{AGENT_HOST}}`. Replies are often read on a phone: keep them short.

Concurrency cap: 3 workers
Disk floor: 20 GB

PR comments in my voice: plain and direct.

## Not on this machine

These parts of CLAUDE.md and the skills are Lucas's own setup and do not exist here. Skip them without asking:

- Mail, calendar and meetings (`scripts/m365.py`, the audiohh vault): there is no M365 access. The morning brief leaves out the meetings part.
- Leads (`lead start evrloot`, `LEAD` lines) and the Evrloot idea bridge (`IDEA`, `TEAM`, `BRIDGE` lines, `ideas/config.json`): not used. Never run `lead start`.
- The Evrloot deploy (`npm run deploy:evrloot`) and everything on evrloot-next.

## Notes vault

{{OWNER}}'s Obsidian vault is synced read-only to `~/Vault` on this Mac. Read it for context on any topic, person or project before asking {{OWNER}}. Never write into it; Syncthing would revert it anyway.

## Results for {{OWNER}}

Finished documents (PDF, PNG, HTML) go to `~/AgentOutbox/<topic>/`, which syncs to {{MAIN_HOST}}. Tell {{OWNER}} the path in one line, and send the file with SendUserFile when it should reach the phone. Never open a browser or app on {{MAIN_HOST}} for this.

## Autonomy

- push: off
- comment: off
- approve: off
- merge: off
