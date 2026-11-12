# Idea bridge

The old Evrloot team posts ideas in a Discord channel. The bridge (`src/ideas-run.ts`) opens a thread on each post, named `I-<n> · <first line of the post>` (at most 100 characters; orch gives it a short title with `idea title` when it first judges the idea) and turns every message into a watcher line, `IDEA <id> <kind> <author>: <text>`. orch does the thinking and answers with `orch idea` commands. The `orch-ideas` skill has the rules orch follows in a thread.

It runs on mocks until the bot exists: `ideas/mock/inbox.jsonl` stands in for the channel, `ideas/mock/outbox.jsonl` holds everything posted back.

## Commands

All of them run in orch's directory as `npm run -s orch -- idea <sub>`.

| Command | What |
| --- | --- |
| `list` | Every idea with its state, and whether the bridge is on. |
| `fake "<text>" --as <user> [--in <id>]` | Mock only: post as someone, in the channel or in an idea's thread. Mock user ids are names. |
| `say <id> <text\|file> [--media <name>]` | Reply in the idea's thread. A file argument is read only from `ideas/drafts/`; any other path, the config included, is posted as text. `--media` attaches one file from the idea's own `ideas/progress/<id>/` folder, checked like a note's media, in any state (notes only post while building). |
| `ask <id> <question file\|text> [--recommend <text>] [--wait]` | Ask the idea's author in the thread, with a real ping for them alone. Any allowed reply in the thread answers it and reaches orch as a normal `msg` line. With a recommendation and no `--wait`, ten minutes without an allowed reply makes the bridge post "No answer in 10 minutes, so I'm going with my recommendation: ..." and write `IDEA <id> timeout <author>: <recommendation>`. If the timeout post fails, the question stays open and the next minute tries again; an answer that arrives before or while it posts wins. Only replies posted after the question, by Discord's timestamps, answer it; a go-shaped reply ("go") answers it too and reaches orch as a `msg`, unless it is a valid go on the plan on screen. `--wait` questions, and questions without a recommendation, never time out; after an hour the bridge writes `IDEA <id> unanswered <author>: <question>` once and flags the idea, so the watcher replays it until orch answers. |
| `plan <id> <file\|text>` | Post the plan with "Reply **go** to build it", tagging and pinging the idea's author. A new plan withdraws the old one and its go, and is approvable once its post is up. While a plan waits for a go and the thread stays quiet for 12 hours (any message restarts the wait), the bridge tags the author again: "The plan above is still waiting for a go", at most three times per plan version. Nothing goes to orch for these. |
| `start <id>` | After a go: dispatch worker `idea-<n>` on the configured repo with the plan as its task, the post quoted as untrusted data, and the progress note rules. |
| `stage <id> <building\|checking\|deploying\|playtesting>` | Where a building idea is, named in its stage pulses. |
| `ship <id> <changelog file\|text>` | Post the changelog and "Live on <liveUrl>, please try it". |
| `record <id> <file\|text>` | Add a line to the idea's dossier without posting anything: the merged PR, gate and review results, the live check, a short summary of the worker's final report, known limits. |
| `park <id> <D-NN>` / `unpark <id>` | A building idea waiting on an open decision stops counting toward `building`, shown as `parked on D-NN` in `list`. The park clears itself on the next `orch idea` command or bridge tick once that decision's file no longer says `- Status: open` (a file without a Status line counts as not open, so does a missing file), or the idea left `building`. Only the decision files of parked ideas are read. |
| `close <id> [reason] [--force]` | Dropped, merged into another idea, or done on request. A building idea needs its worker cleaned up first, or `--force`. |
| `relabel` | One-off: put the id in front of every idea thread still named the old way (`Bats drop loot` becomes `I-3 · Bats drop loot`). Threads already labelled are skipped, every rename is logged, renames go one at a time 2 seconds apart, an archived thread is unarchived for the rename and archived again even when the rename fails, a rename that fails is logged and skipped, and a rename whose re-archive fails is logged and counted on its own as "renamed but left unarchived". Safe to run again, but a rerun does not re-archive those threads: they already carry their id, so it skips them. Discord archives them again by itself after 7 days without a message. |
| `title <id> <title> --keywords a,b,c` | Rename the idea's thread to `<id> · <title>` and keep one bot message in it reading `Keywords: a, b, c`, so Discord search finds the thread by them. The title is at most 8 words and the whole name at most 100 characters; anything longer is refused. Title and keywords lose links, mentions, paths and tokens; keywords are split on commas, and repeats (ignoring case) are dropped. The keywords message is posted first, then edited in place on every later `title` whose keywords differ, and posted again whenever it is gone, even with nothing else changed. An archived thread is unarchived once before anything is posted or edited (Discord refuses edits in it) and archived again at the end, also when the rename failed; a failed re-archive is logged and reported as "left unarchived". A failed rename is logged and refused with the keywords already up; the message id is kept at once, so a rerun edits it rather than posting a second one. A thread that already carries the name is not renamed, and a run with nothing to change touches nothing. Title and keywords are kept in the idea's JSON as `title` only once the rename is done, and `list` shows the title instead of the post's first line. Refused while the kill switch is on. Discord lets a thread be renamed twice per 10 minutes; more waits on its rate limit. |
| `off` / `on` | Kill switch. Off, the bridge answers "paused" once a day per member, stays silent for strangers, and `start` refuses. |

Everything orch posts in a thread (`say`, `ask`, `plan`, `ship`, `close`, question timeouts, progress notes) goes out exactly as written, with one footer line after a blank line that links the other ideas it names: `Related: I-17 <#thread> · I-14 <#thread>`, which Discord shows as links to their threads. An id is `I-` and digits with no letter or digit right before or after it, wherever it stands (code and links included); each one is listed once, in order of first mention. The idea's own id and ids with no thread are left out, and a post that names none gets no footer. The stored text has no footer.

States go `creating` (the thread is being opened), `talk`, `planned`, `approved` (someone said go), `building`, `shipped`, `closed`. An idea the bridge died on while in `creating` gets its thread back on the next start, or is dropped.

## team-general and implementer-discussions

Two more channels in the same server, found by name on first use; their ids are then written to `ideas/config.json` as `team` and `impl`. The bridge watches top-level posts in team-general (not its threads) and keeps every one in `ideas/team/<date>.jsonl`, stripped of links, mentions and anything token-like. Only two kinds reach orch, as `TEAM <kind> <author>: <text>` watcher lines:

- `msg`: meant for orch. It mentions the bot, replies to a bot message, or addresses orch by name: starting with it ("orch, ...", "hey orch"), as a vocative ("thanks orch", "..., orch?") or followed by a colon or comma.
- `suggest`: a suggestion about the bridge or orch. It names one of orch, bot, bridge, harness, idea/ideas channel or thread, thread, worker, agent, Claude, Codex, dossier, changelog, progress notes, pulses, pings or notifications, and asks for a change (should, could, would be nice, suggest, wish, please add/stop, can you, instead of, too many/often/noisy, why does/doesn't, how about, what if). Both are needed, so game talk like "we should add pets" stays quiet.

Everything else is kept, not shown, and so is every post from someone off the allowlist or while the kill switch is on. Nothing is ever answered in team-general automatically. These lines are not replayed when the watcher restarts; the day's file has them.

All of these run as `npm run -s orch -- <team|impl> <sub>`. Everything posted loses links, mentions, paths and tokens first (the progress-note filter, without its length cap), pings nobody, and is refused while the kill switch is on.

| Command | What |
| --- | --- |
| `team backlog [n]` | One-off catch-up: the last n messages (default 200, at most 1000), oldest first, written to `ideas/team/backlog.md` with author, time, text and attachment names. Every message is quoted line by line. |
| `team say <text\|file> [--media <path>]` | Post in team-general. Files only from `ideas/drafts/`. `--media` attaches one file from `ideas/drafts/` or any `ideas/progress/<id>/` folder, given as `ideas/drafts/<name>` or `ideas/progress/<id>/<name>` and checked like a note's media (no symlink, a regular file, at most 8 MB, png, jpg, gif, mp4 or webm by extension and first bytes). Any other path or file is refused with the reason and nothing is posted. |
| `team fake "<text>" --as <user> [--reply-to <user>]` | Mock only: post in team-general as someone; `<@orch>` mentions the bot, `--reply-to orch` replies to it. |
| `impl say <text\|file>` | Post in implementer-discussions. |
| `impl raise <id> <text\|file>` | Post in implementer-discussions led by the idea's id, with the `Related:` line linking its thread (and any other idea named). |
| `impl title <thread id> <title> --keywords a,b,c` | `idea title` for a thread someone opened in implementer-discussions: renamed to `<title>` (no id to lead it), with the same rules and the same one keywords message. Refused for any thread or channel outside implementer-discussions. Kept in `ideas/impl-threads.json` by thread id, read under the ideas lock; a file that does not parse stops the command before anything is posted and is never written over. |
| `impl pin <file>` | Post `ideas/vision.md` (written by people; orch only reads it) or a file under `ideas/drafts/` and pin every message it went out as. Without the Pin Messages permission the post is deleted again and the command says what to grant. |

## Threads never die

A thread stays open after ship and after close. An allowed member's message in the thread of a `shipped` or `closed` idea is feedback: the idea goes back to `talk` as the next round (round 2, 3, ...), is flagged as needing orch, gets a 👀 reaction, and reaches orch as `IDEA <id> feedback <author>: <text>`. Nothing is posted back. A plan posted straight after ship starts the next round too. Strangers and the kill switch apply as anywhere else. A shipped idea, or a reopened round still in `talk`, closes quietly (no post) after 14 days without a message; a later message reopens it all the same. `list` shows the round and marks a round that has not shipped yet as `reopened`; the morning brief lists feedback waiting on its own.

Every idea keeps a dossier that outlives its workers: the steps live in its JSON (`dossier`) and are rendered to `ideas/<id>/dossier.md` on every write. It holds each plan version, each go, every build's worker and branch, what orch records with `record` (PR, gates, review, live check, the worker's report, known limits), the changelog, closes and feedback, grouped by round. From round 2 on the worker's task starts with the dossier of the earlier rounds and the feedback since, then the new plan, so a new worker knows what exists and where. Ideas from before rounds are migrated on every bridge start and `orch idea` command: the dossier is rebuilt from the thread the JSON kept, and a closed idea that shipped becomes `shipped` again, with messages after its ship as feedback.

## Images the team posts

Screenshots posted with an idea or in its thread are kept for orch and the worker. For a message the bridge takes (not a stranger's, not while paused; for a new idea only once its thread exists), each attachment that is a png, jpg, gif or webp by name and by its first bytes, at most 8 MB, is downloaded into `ideas/inbox/<id>/<message id>-<n>.<ext>`, at most 5 per message. Downloads go only to `https://cdn.discordapp.com` and `https://media.discordapp.net`; a redirect is followed only to those hosts, at most 3 times. Anything else is skipped with a log line naming the file and why. The files are untrusted: the bridge only compares their first bytes against the image magic numbers and never opens them otherwise.

Downloads run beside the message queue: the message is recorded at once, together with the images still to fetch (`downloads` in the idea's JSON), the next message never waits for an image, and a failed or broken download skips only that file. A message's images download in parallel, at most 3 at a time across all messages, each within 30 s, and each is written to a temporary name and renamed into place. A bridge that stops mid-download fetches the rest on its next start, keeping the files it had already saved, as it does for a new idea recovered after a crash. A message with attachments reaches the watcher once its downloads are done, even when they failed, as a line ending in ` [N images]`; a thread reply with only an image in it counts as a message (`IDEA I-3 msg ann: [1 image]`). The message in the idea's JSON lists its `screenshots`, and the dossier shows `screenshots: <files>` on the entry for that message (feedback, go) or on a `screenshots` entry of its own. `start` lists every file in `ideas/inbox/<id>/` by absolute path in posting order in the worker's task, so the worker can open them. Closing an idea, by `close` or quietly after 14 days, drops its pending downloads in the same write and deletes its inbox files once the close is saved; images that arrive after the close are not kept, even if the idea reopened meanwhile, and a closed idea's queued downloads give their slots back. A `close --force` while the idea's worker still runs keeps that round's files (`leftovers` in the JSON) for that worker; no later worker is given them, and the bridge deletes them once the worker is gone, even if the idea has reopened. A message's watcher line goes out once its screenshots are recorded; a failed record is retried on the next tick.

## While an idea builds

The worker writes progress notes to `ideas/progress/<id>/notes.jsonl` under orch's directory, one JSON line each: `{"ts": "<ISO>", "text": "<one or two sentences for players>", "media": "<optional file name>"}`, with the media file (png, jpg, gif, mp4, webm, up to 8 MB) in the same folder. Every minute the bridge posts the oldest note it has not posted yet, text plus attachment, once orch has said nothing in the thread for 2 minutes, so a worker that writes several notes at once gets each one posted in order, none skipped. `idea say` and `idea ask` on a building idea first post every waiting note, oldest first, so a question never lands above the work it asks about. With no new note, a stage pulse ("Still on it: running the tests and a code review (12 min in).") goes out after 5 quiet minutes. Note text loses links, mentions, paths (starting with / or ~, or naming a file like game/boat.ts; left/right stays) and token-like strings on the way out. Media is read once through one file descriptor and goes only when the folder resolves to the idea's own progress folder, the file opens without following a symlink and is regular, is at most 8 MB, and is a png, jpg, gif, mp4 or webm by both extension and first bytes; anything else is left out with a log line and the text still posts. `notesSeen` in the idea's JSON holds a key (hash of ts and text) for every note handled, so nothing posts twice, even when the worker rewrites notes.jsonl; a note is recorded only once its post is out, so a failed post is tried again the next minute; an idea that started building before progress notes existed takes the notes already in its file as posted on the first tick, and a rebuild starts after the notes of the build before.

Every new idea, thread message, go, feedback, question timeout and unanswered nudge marks the idea as needing orch until orch answers with `say`, `ask`, `plan`, `start`, `ship` or `close`. `list` and the morning brief show those ideas, and the watcher prints their IDEA lines again when it starts, so nothing posted while orch was down is missed.

## Settings

`ideas/config.json`, every key optional. A file that exists but does not parse stops the bridge and `orch idea` until it is fixed.

```json
{
  "adapter": "mock",
  "channel": "ideas",
  "team": "<team-general id, filled in>",
  "impl": "<implementer-discussions id, filled in>",
  "allowlist": ["ann", "bob"],
  "perDay": 3,
  "building": 1,
  "repo": "evrloot-next",
  "liveUrl": "https://api.runforit.io"
}
```

Only allowlisted user ids can post ideas, talk in their threads and say go; taking someone off the list also takes them out of their own ideas. Everyone else gets a polite no once a day; after that the bridge stays silent and only logs their messages. `perDay` caps new ideas per person per day (the limit is also said once a day), `building` caps ideas building at once; an idea parked on an open decision does not count.

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
3. Invite the bot to the server. Copy the Application ID from General Information and open this URL with it (the permissions are View Channels, Send Messages, Send Messages in Threads, Create Public Threads, Add Reactions, Read Message History, Attach Files, Pin Messages):
   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=2252109051432000
   ```
   It needs View Channels and Read Message History in team-general, Send Messages in team-general and implementer-discussions, and Pin Messages in implementer-discussions for `impl pin`. A bot invited with the older URL gets Pin Messages from its role in Server Settings, Roles. Discord split pinning out of Manage Messages into its own Pin Messages permission; Manage Messages alone no longer pins.
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
