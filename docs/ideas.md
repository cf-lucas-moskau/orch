# Idea bridge

The old Evrloot team posts ideas in a Discord channel. The bridge (`src/ideas-run.ts`) opens a thread on each post, named `I-<n> · <first line of the post>` (at most 100 characters) and turns every message into a watcher line, `IDEA <id> <kind> <author>: <text>`. orch does the thinking and answers with `orch idea` commands. The `orch-ideas` skill has the rules orch follows in a thread.

It runs on mocks until the bot exists: `ideas/mock/inbox.jsonl` stands in for the channel, `ideas/mock/outbox.jsonl` holds everything posted back.

## Commands

All of them run in orch's directory as `npm run -s orch -- idea <sub>`.

| Command | What |
| --- | --- |
| `list` | Every idea with its state, and whether the bridge is on. |
| `fake "<text>" --as <user> [--in <id>]` | Mock only: post as someone, in the channel or in an idea's thread. Mock user ids are names. |
| `say <id> <text\|file>` | Reply in the idea's thread. A file argument is read only from `ideas/drafts/`; any other path, the config included, is posted as text. |
| `ask <id> <question file\|text> [--recommend <text>] [--wait]` | Ask the idea's author in the thread, with a real ping for them alone. Any allowed reply in the thread answers it and reaches orch as a normal `msg` line. With a recommendation and no `--wait`, ten minutes without an allowed reply makes the bridge post "No answer in 10 minutes, so I'm going with my recommendation: ..." and write `IDEA <id> timeout <author>: <recommendation>`. If the timeout post fails, the question stays open and the next minute tries again; an answer that arrives before or while it posts wins. Only replies posted after the question, by Discord's timestamps, answer it; a go-shaped reply ("go") answers it too and reaches orch as a `msg`, unless it is a valid go on the plan on screen. `--wait` questions, and questions without a recommendation, never time out; after an hour the bridge writes `IDEA <id> unanswered <author>: <question>` once and flags the idea, so the watcher replays it until orch answers. |
| `plan <id> <file\|text>` | Post the plan with "Reply **go** to build it", tagging and pinging the idea's author. A new plan withdraws the old one and its go, and is approvable once its post is up. While a plan waits for a go and the thread stays quiet for 12 hours (any message restarts the wait), the bridge tags the author again: "The plan above is still waiting for a go", at most three times per plan version. Nothing goes to orch for these. |
| `start <id>` | After a go: dispatch worker `idea-<n>` on the configured repo with the plan as its task, the post quoted as untrusted data, and the progress note rules. |
| `stage <id> <building\|checking\|deploying\|playtesting>` | Where a building idea is, named in its stage pulses. |
| `ship <id> <changelog file\|text>` | Post the changelog and "Live on <liveUrl>, please try it". |
| `record <id> <file\|text>` | Add a line to the idea's dossier without posting anything: the merged PR, gate and review results, the live check, a short summary of the worker's final report, known limits. |
| `close <id> [reason] [--force]` | Dropped, merged into another idea, or done on request. A building idea needs its worker cleaned up first, or `--force`. |
| `relabel` | One-off: put the id in front of every idea thread still named the old way (`Bats drop loot` becomes `I-3 · Bats drop loot`). Threads already labelled are skipped, every rename is logged, renames go one at a time 2 seconds apart, an archived thread is unarchived for the rename and archived again even when the rename fails, a rename that fails is logged and skipped, and a rename whose re-archive fails is logged and counted on its own as "renamed but left unarchived". Safe to run again, but a rerun does not re-archive those threads: they already carry their id, so it skips them. Discord archives them again by itself after 7 days without a message. |
| `off` / `on` | Kill switch. Off, the bridge answers "paused" once a day per member, stays silent for strangers, and `start` refuses. |

Everything orch posts in a thread (`say`, `ask`, `plan`, `ship`, `close`, question timeouts, progress notes) goes out exactly as written, with one footer line after a blank line that links the other ideas it names: `Related: I-17 <#thread> · I-14 <#thread>`, which Discord shows as links to their threads. An id is `I-` and digits with no letter or digit right before or after it, wherever it stands (code and links included); each one is listed once, in order of first mention. The idea's own id and ids with no thread are left out, and a post that names none gets no footer. The stored text has no footer.

States go `creating` (the thread is being opened), `talk`, `planned`, `approved` (someone said go), `building`, `shipped`, `closed`. An idea the bridge died on while in `creating` gets its thread back on the next start, or is dropped.

## Threads never die

A thread stays open after ship and after close. An allowed member's message in the thread of a `shipped` or `closed` idea is feedback: the idea goes back to `talk` as the next round (round 2, 3, ...), is flagged as needing orch, gets a 👀 reaction, and reaches orch as `IDEA <id> feedback <author>: <text>`. Nothing is posted back. A plan posted straight after ship starts the next round too. Strangers and the kill switch apply as anywhere else. A shipped idea, or a reopened round still in `talk`, closes quietly (no post) after 14 days without a message; a later message reopens it all the same. `list` shows the round and marks a round that has not shipped yet as `reopened`; the morning brief lists feedback waiting on its own.

Every idea keeps a dossier that outlives its workers: the steps live in its JSON (`dossier`) and are rendered to `ideas/<id>/dossier.md` on every write. It holds each plan version, each go, every build's worker and branch, what orch records with `record` (PR, gates, review, live check, the worker's report, known limits), the changelog, closes and feedback, grouped by round. From round 2 on the worker's task starts with the dossier of the earlier rounds and the feedback since, then the new plan, so a new worker knows what exists and where. Ideas from before rounds are migrated on every bridge start and `orch idea` command: the dossier is rebuilt from the thread the JSON kept, and a closed idea that shipped becomes `shipped` again, with messages after its ship as feedback.

## Images the team posts

Screenshots posted with an idea or in its thread are kept for orch and the worker. For a message the bridge takes (not a stranger's, not while paused; for a new idea only once its thread exists), each attachment that is a png, jpg, gif or webp by name and by its first bytes, at most 8 MB, is downloaded into `ideas/inbox/<id>/<message id>-<n>.<ext>`, at most 5 per message. Downloads go only to `https://cdn.discordapp.com` and `https://media.discordapp.net`; a redirect is followed only to those hosts, at most 3 times. Anything else is skipped with a log line naming the file and why. The files are untrusted: the bridge only compares their first bytes against the image magic numbers and never opens them otherwise.

Downloads run beside the message queue: the message is recorded at once, the next message never waits for an image, and a failed or broken download skips only that file. A message with attachments reaches the watcher once its downloads are done, as a line ending in ` [N images]`; a thread reply with only an image in it counts as a message (`IDEA I-3 msg ann: [1 image]`). The message in the idea's JSON lists its `screenshots`, and the dossier shows `screenshots: <files>` on the entry for that message (feedback, go) or on a `screenshots` entry of its own. `start` lists every file in `ideas/inbox/<id>/` by absolute path in posting order in the worker's task, so the worker can open them. Closing an idea, by `close` or quietly after 14 days, deletes its inbox folder; images that arrive after the close are not kept.

## While an idea builds

The worker writes progress notes to `ideas/progress/<id>/notes.jsonl` under orch's directory, one JSON line each: `{"ts": "<ISO>", "text": "<one or two sentences for players>", "media": "<optional file name>"}`, with the media file (png, jpg, gif, mp4, webm, up to 8 MB) in the same folder. Every minute the bridge posts the newest note it has not posted yet, text plus attachment, once orch has said nothing in the thread for 2 minutes; older unposted notes are skipped. With no new note, a stage pulse ("Still on it: running the tests and a code review (12 min in).") goes out after 5 quiet minutes. Note text loses links, mentions, paths (starting with / or ~, or naming a file like game/boat.ts; left/right stays) and token-like strings on the way out. Media is read once through one file descriptor and goes only when the folder resolves to the idea's own progress folder, the file opens without following a symlink and is regular, is at most 8 MB, and is a png, jpg, gif, mp4 or webm by both extension and first bytes; anything else is left out with a log line and the text still posts. `notesSeen` in the idea's JSON holds a key (hash of ts and text) for every note handled, so nothing posts twice, even when the worker rewrites notes.jsonl; a note is recorded only once its post is out, so a failed post is tried again the next minute; an idea that started building before progress notes existed takes the notes already in its file as posted on the first tick, and a rebuild starts after the notes of the build before.

Every new idea, thread message, go, feedback, question timeout and unanswered nudge marks the idea as needing orch until orch answers with `say`, `ask`, `plan`, `start`, `ship` or `close`. `list` and the morning brief show those ideas, and the watcher prints their IDEA lines again when it starts, so nothing posted while orch was down is missed.

## Settings

`ideas/config.json`, every key optional. A file that exists but does not parse stops the bridge and `orch idea` until it is fixed.

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

Only allowlisted user ids can post ideas, talk in their threads and say go; taking someone off the list also takes them out of their own ideas. Everyone else gets a polite no once a day; after that the bridge stays silent and only logs their messages. `perDay` caps new ideas per person per day (the limit is also said once a day), `building` caps ideas building at once.

The live bridge remembers the last message it handled in the channel and in each thread. After a restart it catches up on everything posted since, in the channel and its active threads, before it handles new messages.

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
3. Invite the bot to the server. Copy the Application ID from General Information and open this URL with it (the permissions are View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions, Read Message History, Attach Files):
   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=309237746752
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

Posts from orch ping nobody, mentions in replies are sent with pings switched off, except an `ask`, which pings the idea's author and only them.
