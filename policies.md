# policies

The rules orch enforces. orch never decides for the user what this file marks needs the user. Overrides go in `local.md`, which wins over this file.

## Triage

Every event the watcher prints is sorted into one of three buckets.

Needs the user: a session is blocked on a permission prompt, asks a question, or waits on an approval. Anything touching commits, pushes, merges, deploys, DB writes, outward-facing actions (PR comments, Slack, email, Jira) or money is always needs the user, even if the session only proposes it, except what Autonomy below switches on. A long task that finished and now sits idle waiting for "go" counts too.

FYI: a session finished and reported, nothing pending. Shown when the user asks, never pushed. Exception: when a worker or session the user asked for finishes, orch says so in its own chat in one line with the result, right away.

Handled: interim progress, subagent chatter, the user already typing in that pane (herdr `focused`), or orch's own session. Dropped.

When unsure between FYI and needs the user, read the pane (`herdr agent read <pane>`) before deciding. Still unsure: needs the user.

## Push

One PushNotification per new decision, never for FYI. Under 200 chars, lead with session name, pane and what they'd say. Don't push again for the same open decision.

## Relay and steering

orch relays an answer only after the user gives it, word for word, with `npm run -s orch -- steer <pane> "<text>"`. Prefer SendMessage when the session shows up in ListAgents; use steer otherwise. Never prompt a session that is focused (the user is typing there) or blocked on a dialog; steer refuses both. orch never answers a permission or approval dialog for a session, except the folder trust prompt on a worker worktree it just created from a registered repo.

## Workers

Concurrency cap: 4 workers. Everything runs on one machine; raise it in `local.md` if yours has room.

Disk floor: 20 GB. `orch run` starts no worker while the data volume has less free; `scripts/disk-hygiene.sh --dry-run` shows what can go. Set it in `local.md`.

Each worker runs in its own herdr worktree on branch `orch/<name>`, leaves its changes for orch to commit once the gates pass, and never pushes, merges, opens PRs, deploys or touches databases; those come back as decisions.

Every brief tells the worker to make in-scope implementation and investigation calls itself and report them; it stops only for outward-facing or irreversible actions or a scope change. A worker question that carries a clear recommendation and stays in scope is steered back with "go with your recommendation" only after the user has approved that once for the worker; until then it is needs the user.

A deploy is done only when orch has had each changed feature played end to end on the deployed URL in a real browser, with every asset loading (no 404s), and has reviewed those screenshots. Passing tests on a worker's own stack don't count as proof of a deploy.

Screenshots are evidence only after review. Every brief tells the worker to look at each screenshot critically before showing it and to list the flaws it sees. orch does the same before relaying any image to the user: open it, look for misplaced UI, clipping, characters where they can't stand, seams and wrong labels, and either send it back as a defect or name the flaws next to it.

When a worker reports done, orch runs its gates (`orch gates <name>`). Pass: FYI to the user, plan task marked done, then push and merge as Autonomy allows; whatever it doesn't allow becomes a decision. Fail: steer the worker once with the failing output; a second failure is needs the user.

Cleanup after the work is merged or abandoned. `orch cleanup` refuses a worktree with uncommitted changes or commits on no other branch; abandoning those needs a decision, then `--abandon`.

## Claude, Codex and pairs

Workers are Claude unless the user says otherwise ("with Codex", "both") or the plan task carries a `(codex)` or `(both)` tag.

orch tags a task `(both)` on its own when a miss is expensive: auth and permissions, money, data migrations or deletion, concurrency, security fixes. A pair is the same task given to a Claude and a Codex worker in separate worktrees; it takes two slots. When both are done, `orch judge` runs gates and a bimodel review on each and picks the winner. The winner is pushed and merged as Autonomy allows; the loser is cleaned up with `--abandon` after the user agrees.

Codex and pair workers can run on any registered repo. There is no per-repo Codex marking; orch never asks for one or checks for one.

Workers never commit (orch commits after the gates pass, and Codex's sandbox keeps `.git` read-only). They leave changes uncommitted; `orch gates` makes the one local commit on the worker branch when the gates pass. A Codex permission prompt is a decision, never answered by orch.

`orch review` runs Claude and Codex on the same diff. Findings both report count as confirmed; single-model findings are verified against the code before they reach the user.

## Serious work runs in poteto-mode

Claude workers start in pstack's poteto-mode (`/pstack:poteto-mode`): every worker does real engineering work, and poteto-mode picks the playbook (bug fix, feature, refactoring, babysit) and holds it to verification. orch's worker rules (no commits, no pushes, no PRs) override any playbook step. poteto-mode can only be typed, never invoked by a model, so the first line orch sends a worker starts with it and stays one line; the brief is a file. When orch relays a new substantial task into one of the user's own sessions, it starts the message with `/pstack:poteto-mode` the same way. Questions, status checks and one-line answers go without it. Codex has no pstack.

## PR routine

"Look at the PRs of <repo>" runs the orch-prs skill: the user's PRs with colleague feedback get an address worker; colleagues' PRs nobody reviewed get a bimodel review and a drafted comment that @-mentions the author. Pushing fixes, posting reviews and merging follow Autonomy.

## Autonomy

Outward actions orch takes without asking once switched on (in `local.md`, which wins). Off means a decision first, then the command with `--accepted D-NN`. The commands refuse on their own when neither holds.

- push: off
- comment: off
- approve: off
- merge: off

When on, each still has a bar:
- push: a worker branch or a PR head, only after its gates passed and `orch review` left no blocking finding. Then `orch open-pr` for a new branch. Never force, never straight to the default branch.
- comment: post the drafted review or reply as written in `reviews/`.
- approve: a colleague's PR whose bimodel review left no blocking or medium finding after verification. Anything less gets a comment instead.
- merge: `orch merge` squash-merges only with checks green, no conflicts, no changes requested and every approval branch protection requires; it refuses otherwise. Never `--admin`. Checks still pending: try again on the next pass.

Every autonomous action is logged and listed in the next brief, never pushed as a notification. Deploys, DB writes, force pushes, money, Slack, email, Jira and permission prompts stay needs the user regardless. A merge or push that fails twice becomes a decision.

## Learning

The nightly reflect job only proposes. orch applies an item after the user approves it and logs it. Auto-apply per category, all off until the user switches one on:

- project: off
- memory: off
- policy: off
