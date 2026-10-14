# projects

Repos with known gates. orch works in any git repo (a path, or a folder name under ORCH_CODE_DIR, default ~/code); a row here adds the check commands a worker's result must pass. Gates are the check commands, in backticks, that must pass in the worker's worktree before its work counts as done.

| Repo | Path | Gates | Notes |
|---|---|---|---|
| my-app | ~/code/my-app | `npm run lint`, `npm test` | example row, replace with yours |
