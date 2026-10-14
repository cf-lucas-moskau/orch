# plans

One file per active project, `plans/<repo>.md`, `<repo>` as in `projects.md`. orch rewrites it on every planning pass (`/orch continue <repo>`).

```markdown
# <repo>
Goal: <what done looks like>
Milestone: <the current milestone>

## Tasks
- [ ] <slug>: <task, one line, enough for a worker to start>
- [~] <slug>: <running; the worker is named after the slug>
- [!] <slug>: <blocked, with the decision id>
- [x] <slug>: <done, gates passed>

## Notes
<what orch learned on the way, newest first>
```

A trailing `(codex)` gives the task to a Codex worker, `(both)` to a Claude and a Codex worker whose results `orch judge` compares. No tag means Claude.

Slugs match `[a-z][a-z0-9_-]{0,31}` because they become worker names. `npm run -s orch -- run <repo> <slug>` picks the task text from here and marks it `[~]`.
