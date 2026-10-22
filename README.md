# orch

One chat that runs all your coding agents.

You have five Claude Code sessions open in five panes. One is waiting for a permission, one finished an hour ago and asked you a question, two are working, one is idle. orch is a Claude Code session that watches all of them for you. You ask it "what's going on" and get the short answer. It queues every question that needs you, relays your answers, and starts new workers in their own git worktrees, checks their tests, and has Claude and Codex review the result. You can reach it from your phone via Remote Control.

Landing page: https://orch-agents-lemon.vercel.app

```
you ──▶ orch ──┬──▶ worker  fix-login     ■■■□□□ gates   4m
               ├━●━▶ worker  pr118-cl      ■■□□□□ work    2m
               ├──▶ your session  api      blocked: needs permission
               └──▶ 6 idle sessions
```

## What you need

- macOS (Linux untested), Node 22.6 or newer, git, jq
- [Claude Code](https://claude.com/claude-code)
- [herdr](https://herdr.dev), the terminal multiplexer your agent sessions run in (`brew install herdr`)
- Optional: [Codex CLI](https://github.com/openai/codex) for Codex workers and two-model reviews, [gh](https://cli.github.com) for the PR routine

## Install

```sh
git clone https://github.com/cf-lucas-moskau/orch ~/orch
cd ~/orch
npm run setup
```

Setup checks your tools, creates your local files, and adds one hook to `~/.claude/settings.json` (and `~/.codex/hooks.json` if you have Codex) that writes a line to `~/orch/feed/` whenever a session starts, gets a prompt, stops or needs permission. It backs up every file it changes and is safe to run again. No other dependencies, nothing to `npm install`.

Then:

1. Open `local.md` and put in your name. Open `projects.md` and list your repos with the commands that prove a change works (`npm test`, `npm run lint`).
2. Start herdr, add a workspace called `orch`, and run `npm start` in it.
3. Restart your other Claude sessions so they pick up the hook.

## Use it

Just talk to it.

| You say | orch does |
| --- | --- |
| what's going on | Blocked sessions first, then questions waiting for you, then who is working. Idle ones as a count. |
| decisions | Lists what needs you, each with orch's recommendation. |
| accept D-4 / reject D-4, use the other approach | Writes your answer down and types it into that session for you. |
| run my-app fix-login: the login button does nothing on Safari | Starts a worker in its own worktree and branch. When it's done, orch runs your gates and commits on the branch if they pass. |
| ... with both | Gives the same task to Claude and Codex, then picks the better result with tests and a two-model review. |
| review my-app #118 | Claude and Codex review the PR separately; findings both agree on count, the rest get checked against the code. |
| look at the PRs of my-app | Starts workers for review comments on your PRs and drafts reviews for your colleagues' PRs. |
| continue my-app | Plans the next steps toward a goal you gave it and dispatches workers up to your cap. |
| every weekday at 8:30, look at the PRs of my-app | Sets up a routine. launchd starts it on time, so it keeps running when orch restarts or the Mac reboots. "routines" lists them. |

orch also sends a phone notification when something new needs you and a brief every morning at 08:00.

## orch deck

Type `/deck` in orch for a live pane next to the chat: your sessions as a map with a dot running along the line whenever a message moves, the bus of every prompt and reply, each worker's stage (brief, work, gates, review, judge, push), open decisions and which workflow orch is in.

Focus it with ctrl+x tab. `m b w d f` switch tabs, `j k` select, `s` steer the selected session, `r` read its screen, `g` run gates, `c` clean up, `y` accept the decision, `n` reject it with a reason. Every key hands orch a prompt in your words, so the same rules apply.

The deck is a [Claude Code mod](https://www.claudemod.com) (early access) and docks in fullscreen mode (`"tui": "fullscreen"` in your settings) on terminals 110+ columns wide.

## What orch never does on its own

Push, merge, open or comment on PRs, deploy, touch a database, send anything outside your machine, or answer a permission prompt. Those always become a decision for you. Workers never commit; orch commits on the worker's branch only after your gates pass. The full rules are in `policies.md`; put your own overrides in `local.md`.

Once you trust it, you can let orch push, comment, approve and merge by itself. Copy the `## Autonomy` section from `policies.md` into `local.md` and switch the ones you want to `on`. It still only pushes work that passed your gates and a clean two-model review, approves only PRs with no serious findings, and merges only with green checks and every approval your branch protection requires. Deploys, databases and permission prompts always stay with you.

## Optional extras

- Codex: install it before `npm run setup` (or rerun setup) and say "with Codex" or "with both".
- [pstack](https://github.com/cursor/plugins/tree/main/pstack): if installed, Claude workers start in its poteto-mode, which holds them to real verification.
- Nightly learning: `npm run setup -- --nightly` (macOS) runs a job at 23:40 that reads your corrections from the day and proposes updates to your memory and rules. orch only applies them after you say yes.

## Your files

Everything orch knows lives as plain files in this folder and stays out of git: `feed/` (events), `decisions/`, `plans/`, `workers.json`, `log.md` (what orch did and why), `notes/`, `reviews/`, `learned/`. You can read and edit all of them.

## Uninstall

Remove the hook entries that mention `orch-feed.sh` from `~/.claude/settings.json` and `~/.codex/hooks.json` (or restore the `.bak-orch` copies), then delete the folder.

## Develop

`npm test` runs the unit tests, `npm run test:mod` the deck's tests. The logic is in pure modules under `src/` and `mod/hooks/core.ts`; `CLAUDE.md` is orch's own instructions.

MIT license.
