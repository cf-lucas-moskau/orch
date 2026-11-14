# Inventory: Lucas's setup against the kit

Lucas's real setup, checked read-only item by item on 2026-11-14, against what `AGENT-SETUP.md` builds. Each row says where the item stands:

- **kit**: needed for the two goals (coding workers, unsupervised vault and presentation work). It has a step and a `check.sh` line.
- **added**: missing from the first kit (#49) and added by this audit.
- **Lucas**: specific to Lucas's work. It is listed under "Lucas-specific parts" in `AGENT-SETUP.md` and stays off.
- **skip**: not needed, with the reason.

## Claude Code

| Item | Lucas | Decision | Where |
| --- | --- | --- | --- |
| pstack (poteto-mode) | enabled; every orch Claude worker starts in `/pstack:poteto-mode` (`src/dispatch.ts`, `policies.md`) | **added, required.** It was optional in #49, but workers silently ran without it. Installed from `cf-lucas-moskau/pstack-claude`. `orch run` and `orch address` now refuse to start a Claude worker without it, and `npm run setup` shows it | S6.5, `kit/pstack.sh`, `src/dispatch.ts` `potetoMissing` |
| pstack-team-kit | enabled; poteto-mode calls `deslop`, `control-cli` and `control-ui` from it | **added, required** together with pstack | S6.5 |
| pstack model rule | `/pstack:setup-pstack`. Without it pstack falls back to Cursor model names (grok, gpt) | **added**: `kit/pstack.sh` writes Lucas's role split (models and effort only, `templates/pstack-models.md`) to `~/.claude/pstack/models.md` when it is missing, never over an existing one; `/pstack:setup-pstack` changes it. The file syncs | S6.5 |
| `permissions.defaultMode: auto`, `skipAutoPermissionPrompt` | on | **added.** Without them every worker and routine stops on a permission prompt nobody answers | S6.6, `kit/claude-settings.sh` |
| `remoteControlAtStartup` | on | **added.** Workers become reachable from the phone, as orch already is | S6.6 |
| `agentPushNotifEnabled` | on | **added.** orch pushes each new decision and the morning brief, and the README promised both | S6.6 |
| status line (model, 5 h and weekly limit, cost) | `~/.claude/statusline.sh` | **added**: with several workers on one plan, the limits are worth watching | S6.6, `kit/statusline.sh` |
| `remote-paths.py` hook (UserPromptSubmit) | maps a screenshot path pasted from main to its synced copy | **added** (media relay) | S6.7, `kit/media-relay/` |
| `share-images.py` hook (PostToolUse on Read) | copies images host agents open to `~/AgentImages` | **added** (media relay) | S6.7 |
| screenshot catcher (Swift launchd agent on main) | copies screenshots dragged from the floating thumbnail | **added**, label `agent-main.screenshot-catcher` | S6.7, S9.3 |
| `orch-feed.sh` hooks (all events) | installed by `npm run setup` | kit | S8.1 |
| herdr agent-state hook (`herdr integration install claude`) | installed | kit (by `npm run setup`) | S8.1, check.sh |
| Playwright MCP, headless | user scope | kit. **added**: Google Chrome on both Macs, because the MCP drives Chrome and main had none | S2.2, S6.4 |
| claude.ai connectors (Claude Docs, Data, Atlassian, Canva) | on his account | skip: they come with the human's own claude.ai account | |
| `model: opus`, `effortLevel: high`, theme, `tui`, `awaySummaryEnabled`, `switchModelsOnFlag` | set | skip: the human's preference; orch does not depend on them | |
| `autoMode.allow` rules (approve and merge in his repos, Evrloot deploys, orch merges) | set | Lucas: rights he granted per repo | Lucas-specific section |
| `permissions.allow` `gh pr review`, `gh pr merge` | set | Lucas: same reason | Lucas-specific section |
| `remote.defaultEnvironmentId` | set | skip: an account id, created when the human opens Remote Control | |
| plugin compound-engineering | enabled | optional; offered in one line | S6.5 |
| plugin impeccable | enabled | optional; offered in one line | S6.5 |
| plugins typesafe, swift-lsp, claude-bionify (off), cc-plugin-you-should-know | installed | Lucas | Lucas-specific section |
| user skills agent-bus, image-gen, present | installed | kit (present comes from Lucas directly) | S5.1, S6.3 |
| user skills grill-with-docs, writing-for-agents, retro | installed | Lucas: nothing in orch calls them | Lucas-specific section |
| `~/.claude/agents`, `~/.claude/commands`, keybindings | none | skip: nothing there | |
| per-project memory | synced | kit | S6.2 |
| orch deck mod (`mod/`) | loaded with `npm start` | kit (early access, skipped when `/deck` is unknown) | S8.5 |

## orch's own assumptions (src/, skills, policies, mod)

| Item | Decision | Where |
| --- | --- | --- |
| `claude`, `herdr`, `git`, `jq`, `node` 22.6+ (`--experimental-strip-types`) | kit | S2.2, S2.3 |
| `gh` (PR routine, `prs.graphql`) | kit | S2.4 |
| `codex` (Codex workers, bimodel review) | kit, optional | S2.5 |
| Codex hook trust (`~/.codex/config.toml` `hooks.state`); an untrusted hook makes a Codex worker wait | **added**: the human starts `codex` in `~/orch` once and accepts | S8.1, check.sh |
| `tailscale` CLI (queue page reads the tailnet name) | kit | S3.1 |
| `docker` (`orch cleanup` takes down a worker's compose stacks with their volumes; workers start throwaway databases) | **added**, optional: only if a repo needs it | S2.2b, check.sh |
| `nc`, `du`, `df`, `pgrep`, `launchctl`, `python3` | macOS built-ins; python3 is checked | check.sh |
| `~/code/<repo>` for projects | kit | S8.3 |
| `~/agent-bus` | kit | S4.5 |
| `~/.claude/plugins/cache/*/pstack/*/skills/poteto-mode/SKILL.md` | **added** (pstack) | S6.5 |
| `~/Library/LaunchAgents/orch.routines` | kit | S8.1 |
| `orch.state`, `~/agent-bus/orch-state.json` (companion app) | Lucas | Lucas-specific section |
| `orch-reflect`, `orch-prune` (`npm run setup -- --nightly`) | kit, optional | S8.4 |
| `scripts/m365.py` and its venv `~/.local/share/orch-m365` | Lucas | Lucas-specific section |
| `scripts/disk-hygiene.sh` | Lucas (tuned to his Docker projects) | Lucas-specific section |
| `scripts/herdr-restart.sh` | in the repo already; nothing to install | |
| `deploy-evrloot.ts`, `EVR_DEPLOY_DIR`, `~/code/evrloot-next-deploy` | Lucas | Lucas-specific section |
| ideas bridge, `discord.js`, leads (`ORCH_LEAD`) | Lucas | Lucas-specific section |
| env `ORCH_DIR`, `ORCH_SID`, `ORCH_QUEUE_PORT`, `ORCH_CODE_DIR`, `HERDR_SOCKET_PATH`, `ORCH_HERDR_VERSION` | defaults fit; nothing to set | |
| port 7390 (queue page) | kit | S8.6 |
| PushNotification (policies.md) | **added** (`agentPushNotifEnabled` plus phone notifications) | S6.6 |
| Monitor tool (watcher) | built into Claude Code | |

## Machine and services

| Item | Lucas | Decision | Where |
| --- | --- | --- | --- |
| Homebrew packages orch or skills call: git, gh, herdr, syncthing, jq, python3 | installed (node and jq not from brew on his Mac) | kit | S2.2 |
| poppler (agents read PDFs) | not installed on his host | kit (host) | S2.2 |
| ffmpeg, go, mysql, mongodb, heroku, ruby, espeak, librsvg, go-task | installed | Lucas: his game and other projects | Lucas-specific section |
| Node via nvm 22.x | in use | kit uses brew node (22.6+ checked); either works | S2.2 |
| global npm: `@openai/codex` | installed | kit (optional) | S2.5 |
| `uv` | installed | skip: only the M365 venv uses it | |
| git config: `gh auth git-credential` helper | set | kit (`gh auth setup-git`) | S2.4 |
| git LFS filters, `http.postbuffer`, `core.compression` | set | skip: repo-specific tuning | |
| ssh config shape: two `Host` blocks with `User git` and an IdentityFile (deploy and tunnel keys) | set | skip: Lucas's servers. Kit adds one `Host <host>` block for main to host | S3.3 |
| Tailscale: MagicDNS on, Tailscale SSH off, no exit node | set | kit (same) | S3.1 |
| Syncthing: `claude-config`, `agent-bus` (both ways) | set | kit | S4.3, S4.5 |
| Syncthing: `screenshots` (main to host), `agent-images` (host to main) | set | **added** | S4.5 |
| Syncthing: `agent-outbox`, `vault` | not in Lucas's setup | kit additions for the human's presentation work | S4.5 |
| Syncthing discovery and relays off | off | kit | S4.1 |
| Syncthing Full Disk Access when the vault sits under Documents or Desktop | n/a | **added** as a HUMAN step; otherwise Syncthing silently sees nothing | S4.5 |
| `.stignore` for `~/.claude` | sync conflicts on the signed policy files on his Mac | kit already ignores `policy-limits.json*`, `remote-settings.json*`, `*.sync-conflict-*` | templates |
| LaunchAgents: herdr server, rc-bootstrap, agent-bus watcher | `com.lucas.*` | kit, as `agent-host.*` and `agent-bus.watch` | S5.3, S7.1 |
| LaunchAgents: Evrloot backup and preview tunnel, a side project's server, mysql | loaded | Lucas | Lucas-specific section |
| herdr config (`~/.config/herdr/config.toml`) | only `onboarding = false` | skip | |
| pmset: sleep 0, womp 1 | set (plus caffeinate) | kit (stricter: also disksleep 0, autorestart, powernap 0) | S1.2 |
| Screen Sharing on the host | used | kit | S1.3 |
| FileVault and `fdesetup authrestart` | on | kit | S1.1 |
| Full Disk Access for the screenshot catcher | granted | **added** as a HUMAN step | S6.7 |
| Docker Desktop | installed | **added**, optional | S2.2b |
| Remote Control (`claude remote-control` in herdr, `--remote-control` on orch) | running | kit | S7.1, S8.5 |

## Fixed in the kit while auditing

- `kit/check.sh`: the `rc-bootstrap` and `deck-to-pdf` checks had run together on one line, so the deck-to-pdf check never ran.
- `kit/host-services.sh`: the same kind of merged line in its header comment.

## Notes for Lucas

- His own Mac loads pstack 0.15.10 from a local directory marketplace (`cursor-plugins-local`). The kit installs from the GitHub port, so `check.sh` on his Mac reports the plugins by name prefix only.
- His model rule is at `~/.claude/pstack-models.md`. Nothing reads that path: the port's setup-pstack writes `~/.claude/pstack/models.md`, and the Cursor original writes `~/.cursor/rules/pstack-models.mdc`. So `check.sh` reports it missing on his Mac. Running `/pstack:setup-pstack` once fixes that.
