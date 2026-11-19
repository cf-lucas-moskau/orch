# projects

Repos with known gates. orch works in any git repo (a path, or a folder name under ORCH_CODE_DIR, default ~/code); a row here adds the check commands a worker's result must pass. Gates are the check commands, in backticks, that must pass in the worker's worktree before its work counts as done.

Clone (optional) lists gitignored folders `run` copies from the main checkout into a new worktree as APFS clones, which cost no disk until written; a node_modules entry is cloned only when the worktree's package-lock.json is the main checkout's and main's install matches it. Scratch (optional) lists gitignored test output (e2e captures, fixtures) that cleanup lets go instead of refusing; clone paths count as scratch too.

| Repo | Path | Gates | Clone | Scratch | Notes |
|---|---|---|---|---|---|
| my-app | ~/code/my-app | `npm run lint`, `npm test` | `node_modules` | `e2e/captures` | example row, replace with yours |
