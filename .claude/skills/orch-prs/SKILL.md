---
name: orch-prs
description: PR routine for one repo. Use when the user says "look at the PRs of <repo>", "PR round", "what's open in <repo>", or asks to handle reviews on their PRs or review colleagues' PRs.
---

All commands run in orch's directory as `npm run -s orch -- <command>`. `<repo>` is a registered name, a path, or a folder under the code dir (`ORCH_CODE_DIR`, default ~/code).

1. `prs <repo>` lists open PRs, grouped by what the user has to do, with `next:` lines.
2. Each PR under "Yours, colleague feedback": `address <repo> <n>`. It starts a Claude worker `pr<n>` in poteto-mode on a branch off the PR head, briefed with every open colleague comment verbatim. When the watcher reports it done, run `gates pr<n>` (it commits on a pass), read the worker's verdict table, and file one decision: push the fixes to the PR (`push pr<n>`), with the verdicts and any comment the worker judged not valid. Draft a short reply per thread only when the user asks.
3. Each PR under "Colleagues', not reviewed yet": `review <repo> <n>`, then verify every single-model finding against the code (orch-review skill). Write the comment to `reviews/<date>-<repo>-pr<n>-comment.md`: it opens with `@<author>` (that mention is the ping), then blocking and medium findings, one short paragraph each with `path:line`, minors as one line or left out. The user's voice (see `local.md`), else plain, direct, no em dashes, no praise padding. If nothing survived, say so in two lines and approve nothing. File one decision per PR: post this review? On accept: `post-review <repo> <n> <file>`.
4. Report in one message: what got a worker, what got a review draft (decision ids), and the rest as one line each (approved and ready to merge, waiting on a reviewer, already reviewed, drafts).

Pushing, posting a review and pinging are outward: they always wait for the user's accept. Merging stays theirs.
