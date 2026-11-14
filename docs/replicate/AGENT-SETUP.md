# Agent setup: two Macs, one always-on agent host

You are a Claude Code agent setting up your human's two Macs so they work like Lucas's: one **host** Mac that is always on and runs orch, its workers and every background agent; one **main** Mac the human works on, kept quiet. Work through the phases in order. This file is the recipe; `README.md` beside it is the human's German overview.

## How to run this file

- **Roles.** Every step is tagged `[host]`, `[main]` or `[both]`. Run only the steps for the Mac you are on, in the order below. Some steps need the other Mac to be further along, so the two agents take turns. At each handover, stop and tell the human which step the other Mac's agent runs next; resume when the human says it is done (or check the other Mac's `~/agent-setup-log.md` over SSH once S3.3 works).

| Turn | Mac | Steps | Then |
| --- | --- | --- | --- |
| 1 | host | S0.1 to S4.1 | hand over to main |
| 2 | main | S0.1 to S4.2 (S3.3 gives main SSH to the host; S4.2 pairs both Syncthings) | hand over to host |
| 3 | host | S4.3, S5.1, S5.2, S5.3 | hand over to main |
| 4 | main | S4.4, S4.5, S5.2, S5.3, S5.4, S6.4, S6.5 | hand over to host |
| 5 | host | S6.1 to S8.7 | hand over to main |
| 6 | main | S9.1, S9.2, S9.3, S10.1, S10.2 (and S10.1 on the host over SSH) | done |

S5.1 runs on the host before S4.4 so that main's first sync of `~/.claude` already carries the agent-bus code and skill.
- **Idempotent.** Start every step with its `Verify:` command. Already passing: write "skip" in the log and move on. After doing the step, run `Verify:` again; the step is done only when it passes.
- **Progress log.** Append one line per step to `~/agent-setup-log.md` (`- S4.2 done`, `- S4.2 skip`, `- S4.2 blocked: <why>`). On a restart, read it and continue at the first step not done.
- **The human.** Steps marked `HUMAN:` need hands, a password, a browser login or an account; everything else is yours. Batch the HUMAN parts: before each phase, collect every HUMAN step in it and ask once, with exact clicks or a ready-to-paste Terminal block. Never ask for anything you can find out yourself (`tailscale status`, Obsidian's vault list, `whoami`).
- **Secrets.** Keys, tokens and passwords go only where the step puts them (Keychain, `.env` next to the script, `~/.config/agent-bus`). They never go into a repo, a log, a message or this log file.
- **Shell.** Snippets are bash. Each starts with `. ~/.agent-setup.env` (made in S0.2), so it runs on its own.

`kit/check.sh host|main` checks everything at once, read-only. Run it whenever you are unsure where you are.

## Phase 0: facts

### S0.1 [both] Ask for the facts
HUMAN, in one message: their first name; which Mac is the host and which is main; whether the host is a laptop (lid open or closed); whether they want Codex (OpenAI) too; their Gemini API key, or "later" (only for image generation). Suggest Tailscale names: `<name>-host` and `<name>-main`, lowercase.

Verify: you have all answers.

### S0.2 [both] Write the facts file
Create `~/.agent-setup.env` (mode 600) with the answers:

```bash
OWNER="Tobi"                 # first name, used in prompts and templates
ROLE="host"                  # host or main: this Mac
HOST_NAME="tobi-host"        # Tailscale name of the agent host
MAIN_NAME="tobi-main"        # Tailscale name of the main Mac
KIT="$HOME/orch/docs/replicate/kit"   # host: ~/orch ; main: ~/code/orch-kit
TPL="$HOME/orch/docs/replicate/templates"
```

On main, `KIT` and `TPL` point into `~/code/orch-kit` instead (S2.6).

Verify: `. ~/.agent-setup.env && echo "$ROLE $HOST_NAME $MAIN_NAME"`

## Phase 1: the Mac itself

### S1.1 [both] Fresh user, FileVault, current macOS
An old Mac that held someone else's data gets wiped first: System Settings, General, Transfer or Reset, Erase All Content and Settings. In the setup assistant create the user with the **same short username on both Macs** (synced settings carry absolute paths like `/Users/<name>/orch`) and turn FileVault on.

HUMAN: the wipe, the setup assistant, and the update below if one is pending.

```bash
softwareupdate -l 2>&1 | tail -5     # read-only: lists pending updates
```

If updates are listed, HUMAN runs in Terminal: `sudo softwareupdate -ia --restart`.

Verify: `whoami; fdesetup status; softwareupdate -l 2>&1 | grep -c "No new software available"` prints the same username on both Macs, `FileVault is On.` and `1`.

FileVault and an always-on host: after a power loss the Mac waits at the FileVault unlock screen until someone types the password, so nothing runs. A laptop's battery covers short outages. For planned restarts use `sudo fdesetup authrestart`, which unlocks once. Tell the human this in one line; it is their trade-off.

### S1.2 [host] Never sleep, come back after power loss
HUMAN, in Terminal on the host:

```bash
sudo pmset -a sleep 0 disksleep 0 displaysleep 10 womp 1 autorestart 1 powernap 0
# laptop that runs with the lid closed, only then:
sudo pmset -a disablesleep 1
```

`autorestart` only exists on desktops; on a laptop pmset ignores it.

Verify: `pmset -g | grep -E "^ *(sleep|womp)"` shows `sleep 0` and `womp 1`.

### S1.3 [both] SSH on; Screen Sharing on the host
HUMAN: System Settings, General, Sharing: turn on **Remote Login** (both Macs) and **Screen Sharing** (host). Allow access for their user only.

Verify: `nc -z -G 2 127.0.0.1 22 && echo ssh` on both; on the host also `nc -z -G 2 127.0.0.1 5900 && echo vnc`.

## Phase 2: tools

### S2.1 [both] Command Line Tools and Homebrew
HUMAN, in Terminal (both need the password or a click):

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
```

Verify: `xcode-select -p && /opt/homebrew/bin/brew --version | head -1`

### S2.2 [both] Packages

```bash
brew install git gh jq node herdr syncthing
brew install --cask tailscale-app
brew install --cask google-chrome    # the Playwright MCP (S6.4) drives Chrome headless; agents never open it visibly on main
```

Host only, additionally:

```bash
brew install poppler                 # lets agents read PDFs page by page
```

Verify: `for t in git gh jq node npm herdr syncthing python3; do command -v $t >/dev/null || echo "missing $t"; done; node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' && echo node-ok; test -d "/Applications/Google Chrome.app" && echo chrome`

### S2.2b [host] Docker (only if a repo needs it)
Ask once whether any repo orch will work on runs a database or services with Docker (a `docker-compose.yml`, `compose.yaml` or `Dockerfile` in it). Workers start throwaway stacks there and `orch cleanup` takes them down with their volumes; without Docker that part is skipped silently. If yes:

```bash
brew install --cask docker
```

HUMAN: open Docker once, accept its terms, and in its Settings, General, turn on "Start Docker Desktop when you sign in". Worker stacks fill disk fast; in Settings, Resources, keep the disk limit modest.

Verify: `docker info >/dev/null 2>&1 && echo docker` (or "skip" in the log when no repo needs it).

### S2.3 [both] Claude Code
Usually already there, since you run in it. Otherwise: `curl -fsSL https://claude.ai/install.sh | bash`.

HUMAN: the account needs a Claude plan with Claude Code and Remote Control (Max recommended on the host: orch plus several workers use a lot). Log in with `claude auth login` if `claude auth status` says otherwise.

Verify: `claude --version && claude auth status | grep -q '"loggedIn": true' && echo logged-in`

### S2.4 [both] GitHub CLI
HUMAN: `gh auth login` (GitHub.com, HTTPS, login with a web browser). Then you run `gh auth setup-git`.

Verify: `gh auth status`

### S2.5 [host] Codex CLI (optional)
Only if the human wants Codex workers and two-model reviews.

```bash
npm i -g @openai/codex
```

HUMAN: `codex login` (ChatGPT account).

Verify: `codex --version && codex login status`

### S2.6 [both] The kit
Host: `git clone https://github.com/cf-lucas-moskau/orch ~/orch`. Main: `git clone https://github.com/cf-lucas-moskau/orch ~/code/orch-kit` (main never runs orch; the clone only carries the kit).

Verify: `. ~/.agent-setup.env && test -x "$KIT/check.sh" && echo kit-ok`

## Phase 3: Tailscale

### S3.1 [both] Join the tailnet
HUMAN: open Tailscale from Applications, sign in (the same account on both Macs; create one at tailscale.com if needed, the free plan is enough). In the Tailscale menu, Settings: enable "Launch at login" and install the CLI if offered. In the admin console (login.tailscale.com, Machines), use the machine's menu to **Disable key expiry** for the host, and check that MagicDNS is on (DNS page).

Verify: `tailscale status --json | grep -q '"BackendState": *"Running"' && echo running`

### S3.2 [both] Name the Mac

```bash
. ~/.agent-setup.env
want=$([ "$ROLE" = host ] && echo "$HOST_NAME" || echo "$MAIN_NAME")
tailscale set --hostname="$want"
```

If the name in Verify still differs, HUMAN renames the machine in the admin console (Machines, Edit machine name) to the same value.

Verify: `tailscale status --self --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].split(".")[0])'` prints the wanted name.

### S3.3 [main] SSH from main to host over Tailscale
Plain macOS SSH (Remote Login, S1.3) over the tailnet name. Tailscale SSH is not used: the Mac app does not offer it.

```bash
. ~/.agent-setup.env
[ -f ~/.ssh/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519
grep -q "Host $HOST_NAME" ~/.ssh/config 2>/dev/null || printf 'Host %s\n  User %s\n  ServerAliveInterval 30\n' "$HOST_NAME" "$(whoami)" >> ~/.ssh/config
```

HUMAN, once, in the Claude prompt: `! ssh-copy-id <HOST_NAME>` (types the host's login password).

Verify: `. ~/.agent-setup.env && ssh -o BatchMode=yes "$HOST_NAME" 'hostname; whoami'`

From here on you can run host commands from main with `ssh "$HOST_NAME" '<cmd>'`. Use it for the pairing steps below.

## Phase 4: Syncthing over Tailscale

Syncthing keeps six folders in step between the Macs, talking only over the tailnet (discovery and relays off).

| Folder id | Path (both Macs) | Host | Main | What |
| --- | --- | --- | --- | --- |
| `claude-config` | `~/.claude` | send and receive | send and receive | CLAUDE.md, settings, skills, memory, agent-bus code |
| `agent-bus` | `~/agent-bus` | send and receive | send and receive | bus messages |
| `agent-outbox` | `~/AgentOutbox` | send and receive | send and receive | finished PDFs and images for the human, feedback files back |
| `vault` | vault path on main, `~/Vault` on host | receive only | send only | Obsidian notes, read-only for agents |
| `screenshots` | `~/Screenshots` | receive only | send only | the human's screenshots, so one dragged into a host session is found (S6.7) |
| `agent-images` | `~/AgentImages` | send only | receive only | images host agents open, at a path that also opens on main (S6.7) |

### S4.1 [both] Run Syncthing, Tailscale only

```bash
brew services start syncthing
sleep 5
syncthing cli config options global-ann-enabled set false
syncthing cli config options local-ann-enabled set false
syncthing cli config options relays-enabled set false
syncthing cli config options natenabled set false
```

Verify: `syncthing cli config options relays-enabled get; syncthing cli config options global-ann-enabled get` prints `false` twice.

### S4.2 [main] Pair the Macs (both sides, from main)

```bash
. ~/.agent-setup.env
ME_ID=$(syncthing cli show system | python3 -c 'import json,sys;print(json.load(sys.stdin)["myID"])')
HOST_ID=$(ssh "$HOST_NAME" 'PATH=/opt/homebrew/bin:$PATH syncthing cli show system' | python3 -c 'import json,sys;print(json.load(sys.stdin)["myID"])')
syncthing cli config devices list | grep -q "$HOST_ID" || \
  syncthing cli config devices add --device-id "$HOST_ID" --name "$HOST_NAME" --addresses "tcp://$HOST_NAME:22000" --allowed-networks 100.64.0.0/10
ssh "$HOST_NAME" "PATH=/opt/homebrew/bin:\$PATH; syncthing cli config devices list | grep -q '$ME_ID' || \
  syncthing cli config devices add --device-id '$ME_ID' --name '$MAIN_NAME' --addresses 'tcp://$MAIN_NAME:22000' --allowed-networks 100.64.0.0/10"
echo "$HOST_ID" > ~/.agent-setup.host-id
```

`100.64.0.0/10` is the Tailscale address range, so Syncthing accepts the other Mac only over the tailnet.

Verify (after about 30 s): `curl -s -H "X-API-Key: $(grep -o '<apikey>[^<]*' "$HOME/Library/Application Support/Syncthing/config.xml" | sed 's/<apikey>//')" http://127.0.0.1:8384/rest/system/connections | python3 -c 'import json,sys;print([d["connected"] for d in json.load(sys.stdin)["connections"].values()])'` prints `[True]`.

### S4.3 [host] `~/.claude` as the source
Needs S4.2 done on main (turn 2): until then the host knows no other device. On the host, put the ignore file in place and share the folder. The host's `~/.claude` wins the first sync.

```bash
. ~/.agent-setup.env
cp "$TPL/claude-config.stignore" ~/.claude/.stignore
MAIN_ID=$(syncthing cli config devices list | grep -v "$(syncthing cli show system | python3 -c 'import json,sys;print(json.load(sys.stdin)["myID"])')" | head -1)
[ -n "$MAIN_ID" ] || { echo "main is not paired yet: run S4.2 on main first"; exit 1; }
syncthing cli config folders list | grep -qx claude-config || \
  syncthing cli config folders add --id claude-config --label claude-config --path "$HOME/.claude" --type sendreceive
syncthing cli config folders claude-config devices add --device-id "$MAIN_ID" 2>/dev/null || true
```

Verify: `syncthing cli config folders claude-config devices list | wc -l` is 2 or more.

### S4.4 [main] Take the host's `~/.claude` once, then sync both ways
Back up first, receive only, revert local differences, then switch to send and receive.

```bash
. ~/.agent-setup.env
tar -czf ~/claude-backup-$(date +%F).tgz -C ~ .claude
cp "$TPL/claude-config.stignore" ~/.claude/.stignore
HOST_ID=$(cat ~/.agent-setup.host-id)
syncthing cli config folders list | grep -qx claude-config || \
  syncthing cli config folders add --id claude-config --label claude-config --path "$HOME/.claude" --type receiveonly
syncthing cli config folders claude-config devices add --device-id "$HOST_ID" 2>/dev/null || true
```

Then wait for the download, revert main's own differences, and wait again: the revert runs in the background and re-downloads the host's versions. Switch the folder type only when the folder is idle, needs nothing and has no local changes left. Switching earlier would publish main's leftovers to the host.

```bash
K=$(grep -o '<apikey>[^<]*' "$HOME/Library/Application Support/Syncthing/config.xml" | sed 's/<apikey>//')
settled() { # idle, nothing to fetch, no receive-only changes; waits up to 20 min
  for _ in $(seq 1 240); do
    s=$(curl -s -H "X-API-Key: $K" "http://127.0.0.1:8384/rest/db/status?folder=claude-config" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["state"], d["needFiles"], d["receiveOnlyChangedFiles"])')
    echo "$s"
    case "$s" in "idle 0 0") return 0 ;; "idle 0 "*) [ "${1:-}" = any ] && return 0 ;; esac
    sleep 5
  done
  return 1
}
settled any || { echo "claude-config did not finish downloading"; exit 1; }
curl -s -X POST -H "X-API-Key: $K" "http://127.0.0.1:8384/rest/db/revert?folder=claude-config"
sleep 5
settled || { echo "revert did not finish; leave the folder receive only and look at the Syncthing GUI"; exit 1; }
syncthing cli config folders claude-config type set sendreceive
```

Verify: `syncthing cli config folders claude-config type get` prints `sendreceive`, and `diff <(ssh "$HOST_NAME" cat .claude/skills/agent-bus/SKILL.md) ~/.claude/skills/agent-bus/SKILL.md && echo same` prints `same`.

### S4.5 [main] The other five folders
Needs S4.3 done on the host (turn 3), so both Macs already share a folder and know each other.
Share `agent-bus` and `agent-outbox` both ways, the vault, screenshots and agent images one way. Find the vault path from Obsidian:

```bash
python3 -c 'import json,os;print("\n".join(v["path"] for v in json.load(open(os.path.expanduser("~/Library/Application Support/obsidian/obsidian.json")))["vaults"].values()))'
```

One vault: use it. Several: HUMAN picks. None: HUMAN names the notes folder, or skip the vault. A vault inside iCloud Drive must be kept downloaded (Finder, right-click the folder, Keep Downloaded), or Syncthing sees empty placeholders.

```bash
. ~/.agent-setup.env
VAULT="/path/from/above"
HOST_ID=$(cat ~/.agent-setup.host-id)
ME_ID=$(syncthing cli show system | python3 -c 'import json,sys;print(json.load(sys.stdin)["myID"])')
mkdir -p ~/agent-bus ~/AgentOutbox ~/Screenshots ~/AgentImages
add() { # id path type remote_path remote_type
  syncthing cli config folders list | grep -qx "$1" || syncthing cli config folders add --id "$1" --label "$1" --path "$2" --type "$3"
  syncthing cli config folders "$1" devices add --device-id "$HOST_ID" 2>/dev/null || true
  ssh "$HOST_NAME" "PATH=/opt/homebrew/bin:\$PATH; mkdir -p $4; syncthing cli config folders list | grep -qx '$1' || \
    syncthing cli config folders add --id '$1' --label '$1' --path $4 --type '$5'; \
    syncthing cli config folders '$1' devices add --device-id '$ME_ID' 2>/dev/null || true"
}
add agent-bus    "$HOME/agent-bus"    sendreceive '~/agent-bus'    sendreceive
add agent-outbox "$HOME/AgentOutbox"  sendreceive '~/AgentOutbox'  sendreceive
add vault        "$VAULT"             sendonly    '~/Vault'        receiveonly
add screenshots  "$HOME/Screenshots"  sendonly    '~/Screenshots'  receiveonly
add agent-images "$HOME/AgentImages"  receiveonly '~/AgentImages'  sendonly
```

The agent-bus folder made here is the one `bus-setup` (S5.3) looks for; it then only installs the watcher. `screenshots` and `agent-images` carry the media relay (S6.7): screenshots the human drags into a host session, and images host agents open, back to main at the same path.

A vault under `~/Documents` or `~/Desktop` (also when those live in iCloud) is behind macOS privacy protection, and Syncthing runs from launchd, where it cannot ask. HUMAN on main: System Settings, Privacy & Security, Full Disk Access, add `/opt/homebrew/opt/syncthing/bin/syncthing` and switch it on, then `brew services restart syncthing`.

Verify: `touch ~/AgentOutbox/.ping && sleep 20 && ssh "$HOST_NAME" 'ls -a AgentOutbox | grep -c .ping; ls Vault | head -3'` prints `1` and vault files.

## Phase 5: agent-bus

A signed file mailbox between the two Macs, synced by the `agent-bus` folder. Each Mac runs a launchd watcher that starts a Claude session in herdr for every new request. Code: `kit/agent-bus/`.

### S5.1 [host] Install the code and the skill
`~/.claude` syncs, so installing on the host reaches main by itself.

```bash
. ~/.agent-setup.env
mkdir -p ~/.claude/agent-bus/bin ~/.claude/skills/agent-bus
install -m 755 "$KIT/agent-bus/bus" "$KIT/agent-bus/bus-autorun" "$KIT/agent-bus/bus-setup" ~/.claude/agent-bus/bin/
sed -e "s/{{OWNER}}/$OWNER/g" -e "s/{{MAIN_HOST}}/$MAIN_NAME/g" -e "s/{{AGENT_HOST}}/$HOST_NAME/g" \
  "$KIT/agent-bus/SKILL.md" > ~/.claude/skills/agent-bus/SKILL.md
```

Verify: `~/.claude/agent-bus/bin/bus whoami` prints this Mac's Tailscale name, and `grep -c '{{' ~/.claude/skills/agent-bus/SKILL.md` prints `0`.

### S5.2 [both] Signing key
`~/.claude/agent-bus/bin/bus keygen` (once per Mac; the key stays in `~/.config/agent-bus`, which never syncs).

Verify: `test -f ~/.config/agent-bus/id_ed25519 && echo key`

### S5.3 [both] Watcher

```bash
AGENT_BUS_OWNER="$(. ~/.agent-setup.env; echo "$OWNER")" ~/.claude/agent-bus/bin/bus-setup
```

Verify: `launchctl print gui/$(id -u)/agent-bus.watch >/dev/null && echo watching`

### S5.4 [main] Trust each other (from main)
Needs S5.2 and S5.3 done on both Macs (host in turn 3, main earlier in turn 4).

```bash
. ~/.agent-setup.env
B=~/.claude/agent-bus/bin/bus
ssh "$HOST_NAME" "$B trust '$($B pubkey)'"
$B trust "$(ssh "$HOST_NAME" "$B pubkey")"
```

From now on each watcher rejects unsigned messages.

Verify: round trip. `id=$(~/.claude/agent-bus/bin/bus send "$HOST_NAME" "ping" "Reply with the word pong and nothing else.")`, then `~/.claude/agent-bus/bin/bus wait 180` (in the background) prints a reply from the host with `pong`. The host's herdr shows the session in workspace `agent-bus`. A failure: read `~/Library/Logs/agent-bus-autorun.log` on the host.

## Phase 6: Claude config (synced, so do it on the host)

### S6.1 [host] User CLAUDE.md
Fill `templates/CLAUDE.md` with the human's details (ask for role, company, stack in one question; the rest you know) and write it to `~/.claude/CLAUDE.md`. Keep anything already in an existing one.

Verify: `grep -c '{{' ~/.claude/CLAUDE.md` prints `0`.

### S6.2 [host] Memory
Nothing to install. Claude Code keeps per-project memory under `~/.claude/projects/<project>/memory/`; the ignore file syncs exactly those folders, so what an agent learns on one Mac is known on the other.

Verify: `grep -q 'projects/\*/memory' ~/.claude/.stignore && echo synced`

### S6.3 [host] Skills: image-gen, present
image-gen:

```bash
. ~/.agent-setup.env
mkdir -p ~/.claude/skills/image-gen
cp "$KIT/image-gen/SKILL.md" "$KIT/image-gen/generate.py" ~/.claude/skills/image-gen/
```

With a Gemini key from S0.1, write `~/.claude/skills/image-gen/.env` containing `GEMINI_API_KEY=<key>`, mode 600. Without one, say once that image generation waits for a key (aistudio.google.com, Get API key).

present (HTML slide decks): it is Lucas's own skill and not in this public repo. HUMAN: ask Lucas for the `present` skill folder and put it at `~/.claude/skills/present/` (a `skill.md` or `SKILL.md` plus `LEARNINGS.md`).

Verify: `ls ~/.claude/skills/image-gen/generate.py ~/.claude/skills/present/ && python3 ~/.claude/skills/image-gen/generate.py --help >/dev/null && echo skills`

### S6.4 [both] Playwright MCP
`~/.claude.json` is per Mac, so run this on both.

```bash
claude mcp list 2>/dev/null | grep -q '^playwright' || claude mcp add -s user playwright -- npx @playwright/mcp@latest --headless
```

On main it stays headless: agents never open a visible browser there.

Verify: `claude mcp list | grep playwright`

### S6.5 [both] pstack (required)
orch starts every Claude worker in pstack's poteto-mode (`/pstack:poteto-mode`, `policies.md`), and `orch run` refuses to start a Claude worker without it. Install Lucas's public Claude Code port of pstack and pstack-team-kit (the plugin list is per Mac, so on both):

```bash
. ~/.agent-setup.env
bash "$KIT/pstack.sh"
```

It runs `claude plugin marketplace add cf-lucas-moskau/pstack-claude`, `claude plugin install pstack@pstack-claude` and `claude plugin install pstack-team-kit@pstack-claude`, skipping what is already there.

When `~/.claude/pstack/models.md` is missing, the script writes a default from `templates/pstack-models.md` (Opus for code and judgment, Sonnet for bulk exploration, effort high); it never overwrites one. The file syncs to main. Without it pstack falls back to Cursor model names that Claude Code cannot run.

HUMAN, once: restart Claude so the plugins load (exit, then `claude --continue`). Tell the human in one line that `/pstack:setup-pstack` changes the models whenever they like.

Verify: `claude plugin list --json | jq -e 'any(.[]; .id == "pstack@pstack-claude" and .enabled) and any(.[]; .id == "pstack-team-kit@pstack-claude" and .enabled)' && echo pstack`, and that the slash command loads (one short headless run):

```bash
cd "$(mktemp -d)" && echo "/pstack:poteto-mode Do not do any task. Reply with only the second-level markdown heading that comes first in the skill text you were given, or NONE." | claude -p --no-session-persistence --tools "" | grep -q Non-negotiables && echo poteto-mode
```

Also verify `test -f ~/.claude/pstack/models.md && echo models`.

Optional, offer in one line: Lucas also has `compound-engineering` (`claude plugin marketplace add EveryInc/compound-engineering-plugin`, then `claude plugin install compound-engineering@compound-engineering-plugin`) and `impeccable` for frontend design (`claude plugin marketplace add pbakaus/impeccable`, then `claude plugin install impeccable@impeccable`). Nothing in orch needs them.

### S6.6 [host] Settings for unattended agents
Workers, bus sessions and routines run with nobody watching. Each permission prompt would stop them for hours, and orch's decision pushes need push notifications.

```bash
. ~/.agent-setup.env
bash "$KIT/claude-settings.sh"
```

It merges into `~/.claude/settings.json` (the first run keeps the original as `settings.json.bak-agent-setup`; other keys stay, and so does an existing status line, which the script then names): `permissions.defaultMode: "auto"` and `skipAutoPermissionPrompt: true` (auto mode: a classifier reviews every action instead of asking), `remoteControlAtStartup: true` (every session, workers included, shows up in the Claude app), `agentPushNotifEnabled: true` (orch's push for each new decision and the morning brief), a status line with the 5-hour and weekly limit, and the two media-relay hooks of S6.7. The file syncs, so main gets the same.

HUMAN: in the Claude app on the phone, allow notifications. If the account has no auto mode, say so: workers then stop on prompts, and orch reports them as blocked.

Verify: `jq -e '.permissions.defaultMode=="auto" and .skipAutoPermissionPrompt and .remoteControlAtStartup and .agentPushNotifEnabled and (.statusLine.command != null)' ~/.claude/settings.json && echo settings`

### S6.7 [host, main] Media relay
Dragging a screenshot from main into a host session (through `herdr --remote` or Screen Sharing) pastes a path that only exists on main; `remote-paths.py` points the agent at the synced copy in `~/Screenshots`. In the other direction `share-images.py` copies every image a host agent opens into `~/AgentImages`, so a path the agent shows opens on main too. Both hooks are installed by S6.6; the folders come from S4.5.

Host: mark it as the sender, so `share-images.py` does nothing on main.

```bash
mkdir -p ~/.config/agent-images ~/AgentImages && touch ~/.config/agent-images/sender
```

Main (turn 6, S9.3): screenshots go to `~/Screenshots`, and a small launchd agent also catches ones dragged straight from the floating thumbnail.

```bash
. ~/.agent-setup.env
bash "$KIT/media-relay/screenshot-catcher-install.sh"
```

HUMAN, if the script says so: give `~/.local/bin/screenshot-catcher` Full Disk Access (it opens the right Settings page), then `launchctl kickstart -k gui/$(id -u)/agent-main.screenshot-catcher`.

Verify, host: `test -f ~/.config/agent-images/sender && echo sender`. Main: `defaults read com.apple.screencapture location` prints `~/Screenshots` expanded, and `~/.local/bin/screenshot-catcher --check` prints `ok`.

## Phase 7: host services

### S7.1 [host] herdr server and Remote Control, started by launchd

```bash
. ~/.agent-setup.env
bash "$KIT/host-services.sh"
```

This installs two launchd jobs:

- `agent-host.herdr-server` keeps the herdr server running.
- `agent-host.rc-bootstrap` (every 5 min) makes sure herdr's `remote-control` workspace runs `claude remote-control`, so the human can start sessions on the host from the Claude app or claude.ai/code.

orch itself is not started by launchd; after a reboot it comes back through one human step (S8.7).

Verify: `herdr status server | grep "status: running" && herdr workspace list | grep -q '"label":"remote-control"' && echo services`

HUMAN, once: in the Claude app on the phone, open Code and check that the host shows up as an environment.

### S7.2 [host] Slide decks to PDF

```bash
npm i --prefix ~/.local/share/deck-to-pdf playwright-core
```

Verify with a one-slide deck:

```bash
. ~/.agent-setup.env
mkdir -p /tmp/deck-test
printf '%s\n' '<!doctype html><style>.slide{position:absolute;inset:0;opacity:0}.slide.active{opacity:1}</style>' \
  '<div id="deck"><div class="slide active"><h1>Test</h1></div><div class="slide"><h1>Two</h1></div></div>' > /tmp/deck-test/t.html
NODE_PATH=~/.local/share/deck-to-pdf/node_modules node "$KIT/deck-to-pdf.mjs" /tmp/deck-test/t.html
```

prints `/tmp/deck-test/t.pdf (2 slides)`. Read the PDF (poppler makes that work) and check both pages show their slide.

## Phase 8: orch on the host

orch is a Claude Code session that watches every other agent session, queues what needs the human, and runs workers in their own git worktrees. Read `~/orch/README.md` once; it is the user manual.

### S8.1 [host] Setup

```bash
cd ~/orch && npm run setup
```

It checks tools, creates `local.md`, `projects.md`, `workers.json`, `log.md` and the ledger folders, installs herdr's agent-state hooks, adds `hooks/orch-feed.sh` to `~/.claude/settings.json` (and Codex's hooks) and installs the launchd routine scheduler `orch.routines`. Safe to rerun.

Verify: `grep -q orch-feed.sh ~/.claude/settings.json && launchctl print gui/$(id -u)/orch.routines >/dev/null && echo orch-setup`

With Codex (S2.5): Codex runs hooks from `~/.codex/hooks.json` only after someone trusted them once, and an unattended Codex worker would sit on that question. HUMAN, once: `cd ~/orch && codex`, accept the folder and the hooks it lists, then quit. Verify: `grep -c 'hooks.json:session_start' ~/.codex/config.toml` prints `1` or more.

The hook lives in the synced `settings.json`, so it also runs on main; there `~/orch` does not exist and the hook does nothing, by design.

### S8.2 [host] local.md
Replace `~/orch/local.md` with `templates/local.md`, placeholders filled (`{{USER}}` is the macOS short name). It tells orch that M365 mail and calendar, leads, the Evrloot idea bridge and deploys are Lucas's and absent here.

Verify: `grep -c '{{' ~/orch/local.md` prints `0`.

### S8.3 [host] projects.md
Ask the human which repos orch should work on. For each: clone it to `~/code/<repo>` on the host, find the commands that prove a change works (`package.json` scripts, the CI workflow) and add a row to `~/orch/projects.md`. Remove the example row.

Verify: every repo row's path exists: `grep '^|' ~/orch/projects.md | tail -n +3 | awk -F'|' '{gsub(/ /,"",$3); print $3}' | while read -r p; do test -d "${p/#\~/$HOME}" && echo "ok $p" || echo "missing $p"; done`

### S8.4 [host] Nightly learning (optional)
`cd ~/orch && npm run setup -- --nightly` adds a 23:40 job that reads the day's corrections and proposes memory and rule updates, applied only after the human says yes. Offer it in one line.

### S8.5 [host] Start orch in herdr
```bash
herdr workspace list | grep -q '"label":"orch"' || {
  pane=$(herdr workspace create --cwd "$HOME/orch" --label orch --no-focus | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
  sleep 2
  herdr pane run "$pane" "cd ~/orch && npm start"
}
```

HUMAN, once: attach (`herdr --remote <HOST_NAME>` from main after S9.1, or `herdr` in Terminal on the host), switch to workspace `orch`, accept the folder trust prompt if Claude shows one, and send the first prompt: "what's going on". The answer lists the sessions herdr shows. Detach; herdr keeps running.

`npm start` runs `claude -n orch --remote-control orch --plugin-dir ./mod`: orch with Remote Control on (reachable as "orch" from the phone and claude.ai/code) and the deck mod (`/deck`). The deck is an early-access Claude Code mod; if `/deck` is unknown, skip it, nothing else depends on it.

On its first turn orch arms its watcher (feed, herdr state, the decision queue page on port 7390) and adds the `morning-brief` routine; that is in orch's own `CLAUDE.md`.

Verify: `herdr workspace list | grep -q '"label":"orch"' && nc -z -G 2 127.0.0.1 7390 && test -f ~/orch/routines/morning-brief.md && echo orch-up` (allow a minute after the first prompt).

### S8.6 [host] The decision queue page
The page serves every open decision on `http://127.0.0.1:7390` and on the host's tailnet name. From the tailnet it needs a one-time login link per device; orch relays it from the watcher's `QUEUE started` line, and it is also in `~/Library/Logs/orch.queue.log`. The phone (with the Tailscale app) is the natural place for it.

Verify: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7390/` prints `200`.

### S8.7 [host] After a reboot: one human step
launchd brings back the herdr server and Remote Control by itself; orch comes back when someone attaches to herdr. HUMAN, after every reboot or power loss of the host:

1. Attach to herdr: `herdr --remote <HOST_NAME>` from main, or `herdr` in Terminal on the host (Screen Sharing), or open the orch pane via Remote Control. herdr restores orch's session in workspace `orch`.
2. Tell orch: `restore`. It re-arms its watcher (which brings back the queue page and the routine checks) and resumes the sessions that died with the reboot.

Tell the human this once, in two lines, when phase 8 is done. Nothing to verify now; after the first real reboot, `bash "$KIT/check.sh" host` passes again.

## Phase 9: the main Mac
Turn 6. Every earlier `[main]` and `[both]` step is done by now (turns 2 and 4). Then:

### S9.1 [main] Reach the host's herdr
`herdr --remote <HOST_NAME>` attaches to the host's herdr over SSH: orch, workers, agent-bus sessions, in this terminal, nothing running locally.

Verify: `. ~/.agent-setup.env && ssh -o BatchMode=yes "$HOST_NAME" 'PATH=/opt/homebrew/bin:$PATH herdr status server' | grep "status: running"`

### S9.2 [main] Fetch worker branches without GitHub
In each local clone of a repo orch works on, add the host as a remote, so a worker's branch can be read locally before anything is pushed:

```bash
. ~/.agent-setup.env
repo=my-app   # the repo folder name under ~/code on both Macs
git -C ~/code/$repo remote get-url agent-host >/dev/null 2>&1 || git -C ~/code/$repo remote add agent-host "$HOST_NAME:code/$repo"
git -C ~/code/$repo fetch agent-host 'refs/heads/orch/*:refs/remotes/agent-host/orch/*'
```

Verify: `git -C ~/code/$repo branch -r | grep agent-host` after the first worker ran.

### S9.3 [main] Screenshot catcher
The main half of S6.7: run `screenshot-catcher-install.sh` there and its Verify.

## Phase 10: final checks

### S10.1 [both] Status
`bash "$KIT/check.sh" host` on the host, `bash "$KIT/check.sh" main` on main. Every line `ok`, apart from the optional ones the human declined. Fix what is MISSING by going back to its step.

### S10.2 [main] End to end
1. Bus: the S5.4 round trip once more, now from host to main as well (`ssh "$HOST_NAME" '~/.claude/agent-bus/bin/bus send <MAIN_NAME> ping "Reply pong."'`).
2. Outbox: the host writes `~/AgentOutbox/setup-test/hello.txt`; it appears on main within a minute.
3. orch worker: HUMAN tells orch (phone or `herdr --remote`): `run <repo> setup-test: add one line to the README saying the agent host works, nothing else`. orch starts a worker, runs the gates when it reports done, and commits on `orch/setup-test`. Fetch it on main with S9.2 and look at the diff. Then tell orch `clean up setup-test --abandon`.
4. Remote Control: on the phone, open the Claude app, Code, the "orch" session: it answers.

Done when all four pass. Report to the human in a few lines: what runs where, what they declined, and the two playbooks in `PLAYBOOKS.md`.

## Known limits

Found in review and left as they are. None blocks the setup; fix one when it bites.

- **bus-autorun state never shrinks.** Every message leaves small files in `~/.cache/agent-bus-autorun/{attempts,prompts,notified,failed}`, and auto replies nobody reads stay in the inbox and get their signature re-checked on every scan. Harmless for months; `bus inbox` plus `bus read` clears replies.
- **bus-autorun closes waiting sessions.** A bus session older than an hour that is not `working` gets its tab closed, also when it is blocked on a question. Its request is already archived, so it is not retried. Answer bus sessions within the hour.
- **Retry tabs are forgotten.** When a request is retried after 15 minutes, the first attempt's tab is no longer tracked for cleanup; close it in herdr by hand.
- **rc-bootstrap can type twice.** In the 10 s while `rc-loop.sh` restarts `claude remote-control`, the 5-minute check may see no claude and type `rc-loop.sh` into the running loop. The pane then runs a second loop; closing the tab lets the job start a clean one.
- **image-gen errors.** An empty `candidates` list (some safety blocks) or a network error prints a Python traceback instead of "no image in response". Treat a traceback as the same thing: rephrase or retry.
- **Screenshot catcher can copy a half-written file.** It copies a thumbnail screenshot the first time it sees it; if macOS is still writing it, the host keeps a truncated image under that name. Take the screenshot again.
- **`CLAUDE_CONFIG_DIR` and the hooks.** `claude-settings.sh` honours it for where it installs, but the hook and status-line commands it writes always point at `~/.claude`. Only matters for a second Claude profile.
- **deck-to-pdf trailing page.** A deck with another `div` after the last slide inside `#deck` gets one blank last page. Delete it or move that element out of `#deck`.

## Lucas-specific parts (skip unless asked)

orch's repo carries features that only make sense for Lucas. They stay off by default and `templates/local.md` tells orch so:

- **Evrloot idea bridge** (`docs/ideas.md`, `ideas/`, Discord bot, `IDEA`/`TEAM`/`BRIDGE` lines): runs only when `ideas/config.json` says `discord`. Leave the file absent.
- **Leads** (`lead start evrloot`, `src/lead.ts`): a long-running session per area. Only `evrloot` exists. Never start it.
- **M365 mail and calendar** (`scripts/m365.py`): reads Lucas's TIKI Outlook. Needs its own Azure sign-in; not part of this setup.
- **Evrloot deploy** (`npm run deploy:evrloot`) and the orch companion app (`companion/`, `npm run setup -- --state`): not needed.
- **Auto mode allow rules and `gh pr review`/`gh pr merge` allow rules** in Lucas's `settings.json`: they let orch merge, approve and deploy in his repos once he asked. The human grants such rights per repo later, in `local.md` (Autonomy) and `autoMode.allow`, never during setup.
- **Lucas's own skills** `grill-with-docs`, `writing-for-agents`, `retro` and the plugins `typesafe`, `swift-lsp`, `claude-bionify`: personal tools, nothing in orch or the playbooks calls them.
- **Evrloot launchd jobs, MySQL, MongoDB, Heroku, Go, ffmpeg**: his game and other projects. ffmpeg only serves his motion reviews of game footage.
- **`disk-hygiene.sh`** (`scripts/`): tuned to his Docker projects; `orch run` points at it when the disk floor is hit, and its `--dry-run` is harmless anywhere.

See `INVENTORY.md` for every item checked and why it is in, Lucas-specific or skipped.
