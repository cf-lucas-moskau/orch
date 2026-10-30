# Idea bridge

The old Evrloot team posts ideas in a Discord channel. The bridge (`src/ideas-run.ts`) opens a thread on each post and turns every message into a watcher line, `IDEA <id> <kind> <author>: <text>`. orch does the thinking and answers with `orch idea` commands. The `orch-ideas` skill has the rules orch follows in a thread.

It runs on mocks until the bot exists: `ideas/mock/inbox.jsonl` stands in for the channel, `ideas/mock/outbox.jsonl` holds everything posted back.

## Commands

All of them run in orch's directory as `npm run -s orch -- idea <sub>`.

| Command | What |
| --- | --- |
| `list` | Every idea with its state, and whether the bridge is on. |
| `fake "<text>" --as <user> [--in <id>]` | Mock only: post as someone, in the channel or in an idea's thread. Mock user ids are names. |
| `say <id> <text\|file>` | Reply in the idea's thread. A file argument is read only from under `ideas/`; any other path is posted as text. |
| `plan <id> <file\|text>` | Post the plan with "Reply **go** to build it". A new plan withdraws the old one and its go, and is approvable once its post is up. |
| `start <id>` | After a go: dispatch worker `idea-<n>` on the configured repo with the plan as its task and the post quoted as untrusted data. |
| `ship <id> <changelog file\|text>` | Post the changelog and "Live on <liveUrl>, please try it". |
| `close <id> [reason]` | Done, dropped, or merged into another idea. |
| `off` / `on` | Kill switch. Off, the bridge answers "paused" once a day per member, stays silent for strangers, and `start` refuses. |

States go `talk`, `planned`, `approved` (someone said go), `building`, `shipped`, `closed`.

## Settings

`ideas/config.json`, every key optional:

```json
{
  "adapter": "mock",
  "channel": "ideas",
  "allowlist": ["ann", "bob"],
  "perDay": 3,
  "building": 1,
  "repo": "evrloot-next",
  "liveUrl": "https://api.runforit.io"
}
```

Only allowlisted user ids can post ideas and say go (the idea's author always can). Everyone else gets a polite no once a day; after that the bridge stays silent and only logs their messages. `perDay` caps new ideas per person per day, `building` caps ideas building at once.

## Try it on mocks

```bash
echo '{"allowlist": ["ann"]}' > ideas/config.json
npm run -s orch -- idea fake "Bats drop more loot" --as ann
npm run -s ideas -- --once
npm run -s orch -- idea list
cat ideas/mock/outbox.jsonl
```

For a running bridge, `npm run -s ideas` polls the mock inbox every second.

## Going live

1. Create the bot. On https://discord.com/developers/applications click New Application and name it orch. Under Bot, click Reset Token and copy the token. On the same page, switch on **Message Content Intent** under Privileged Gateway Intents and save.
2. Store the token, from orch's directory:
   ```bash
   mkdir -p secrets && pbpaste > secrets/discord-token && chmod 600 secrets/discord-token
   ```
3. Invite the bot to the server. Copy the Application ID from General Information and open this URL with it (the permissions are View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions, Read Message History):
   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=309237713984
   ```
4. Get the ids. In Discord, Settings, Advanced, switch on Developer Mode. Right-click the ideas channel and Copy Channel ID; right-click each team member and Copy User ID.
5. Write the config:
   ```json
   { "adapter": "discord", "channel": "<channel id>", "allowlist": ["<user id>", "<user id>"] }
   ```
6. Install discord.js (an optional dependency, only the live adapter needs it): `npm install`.
7. Try it in the foreground first: `npm run -s ideas`, post in the channel, check that a thread opens with a 👀 reaction and `ideas/I-<n>.json` appears. Stop it with Ctrl-C.
8. Load the LaunchAgent so the bridge survives restarts:
   ```bash
   sed -e "s|{{ORCH_DIR}}|$HOME/orch|" -e "s|{{PATH}}|$PATH|" -e "s|{{LOG}}|$HOME/Library/Logs/orch.ideas.log|g" \
     launchd/orch.ideas.plist > ~/Library/LaunchAgents/orch.ideas.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/orch.ideas.plist
   ```
   Its log is `~/Library/Logs/orch.ideas.log`. To stop it: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/orch.ideas.plist`.

Posts from orch never ping anyone: mentions in replies are sent with pings switched off.
