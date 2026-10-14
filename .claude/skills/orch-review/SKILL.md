---
name: orch-review
description: Bimodel code review with Claude and Codex. Use for /orch review, when the user asks to review a PR or branch, or when a worker's work needs review before a push or merge decision.
---

1. `npm run -s orch -- review <repo> <#pr|branch|sha> [--base <ref>]` in orch's directory. `<repo>` is a registered name, a path, or a folder under the code dir (`ORCH_CODE_DIR`, default ~/code). It checks the change out in a temporary worktree, runs Claude and Codex headless on the same prompt, matches their findings and writes `reviews/<date>-<repo>-<ref>.md`.
2. Verify every finding under "Claude only" and "Codex only": read the cited code and keep it only if the failure scenario really happens. Agreed findings count without that check.
3. Report to the user: blocking and medium findings that survived, one line each, agreed ones marked. Minors as a count. If anything blocking survived, or the review gates a merge, file a decision.

Reviews never post to GitHub. Commenting on a PR is an outward action and needs the user.
