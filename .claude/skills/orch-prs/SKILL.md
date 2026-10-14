---
name: orch-prs
description: PR routine for one repo. Use when the user says "look at the PRs of <repo>", "PR round", "what's open in <repo>", or asks to handle reviews on their PRs or review colleagues' PRs.
---

All commands run in orch's directory as `npm run -s orch -- <command>`. `<repo>` is a registered name, a path, or a folder under the code dir (`ORCH_CODE_DIR`, default ~/code).

1. `prs <repo>` lists open PRs, grouped by what the user has to do, with `next:` lines.
2. Each PR under "Yours, colleague feedback": `address <repo> <n>`. It starts a Claude worker `pr<n>` in poteto-mode on a branch off the PR head, briefed with every open colleague comment verbatim. When the watcher reports it done, run `gates pr<n>` (it commits on a pass) and read the worker's verdict table. Push the fixes to the PR with `push pr<n>`, then note the verdicts and any comment the worker judged not valid in the report. Draft a short reply per thread only when the user asks.
3. Each PR under "Colleagues', not reviewed yet": `review <repo> <n>`, then verify every single-model finding against the code (orch-review skill). Write the comment to `reviews/<date>-<repo>-pr<n>-comment.md`: it opens with `@<author>` (that mention is the ping), then blocking and medium findings, one short paragraph each with `path:line`, minors as one line or left out. The user's voice (see `local.md`), else plain, direct, no em dashes, no praise padding. If no blocking or medium finding survived, the comment is two lines and it goes out with `post-review <repo> <n> <file> --approve`; otherwise `post-review <repo> <n> <file>`.
4. Each PR under "Yours, approved, nothing open": `merge <repo> <n>`. A refusal (checks pending or failing, conflicts, missing approval) goes in the report as one line, not a decision; pending checks are retried on the next round.
5. Report in one message: what got a worker, what was pushed, reviewed, approved or merged, what is waiting and why, one line each.

`push`, `post-review` and `merge` follow Autonomy in `policies.md` and `local.md`. When one refuses because its switch is off, file a decision instead and rerun it with `--accepted D-NN` after the user accepts.
