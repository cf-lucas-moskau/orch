---
name: orch-continue
description: Run a planning pass on a project or give the morning brief. Use for /orch continue <project>, when the user sets a project goal, or when the 08:00 brief fires or they ask what happened overnight.
---

Plan format is in `plans/README.md`.

New goal: write `plans/<repo>.md` with Goal, Milestone and tasks small enough for one worker each, show it to the user, and dispatch only after they say go.

continue <repo>:
1. `npm run -s orch -- continue <repo>` prints task states, running workers and what fits under the cap.
2. Fold results in: for each `[~]` task whose worker finished, read its last report (`herdr agent read <pane>`) and gates result; mark `[x]`, or back to `[ ]` with a note, or `[!]` with the decision id.
3. Replan: rewrite tasks and milestone from what was learned. Next milestone only when every task of this one is `[x]`.
4. Dispatch each task in "dispatch next" with the orch-dispatch skill; a `(codex)` or `(both)` tag sets the kind. Tag new risky tasks `(both)` as `policies.md` describes. Anything touching push, merge, deploy, DB or outward actions becomes a decision instead.
5. Commit nothing; report in three lines: moved, dispatched, waiting on the user.

brief: run `npm run -s board`, then `npm run -s orch -- brief`, and turn its output into a phone-length message: decisions waiting first, then what moved, workers, plans, learned items to review (with the orch-learn skill). Push it once.
