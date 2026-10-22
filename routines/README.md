# routines

Recurring tasks, one file per routine, `routines/<name>.md`. launchd runs `npm run -s orch -- tick` every minute (`npm run setup` installs it), so routines keep running when orch restarts, crashes or the Mac reboots. Create them with `orch routine add` or by hand.

```markdown
# <name>
Schedule: weekdays 08:30
Mode: orch
Repo: <repo, needed for worker, optional for headless>
Status: active

<the prompt, as many lines as needed>
```

Schedule: `daily 08:00`, `weekdays 08:30`, `weekends 10:00`, `mon,thu 09:00,14:00`, `every 2h`, `every 30m`. Local time.

Mode:
- `orch` (default without a repo): the prompt goes to the orch session as the user's words, like "look at the PRs of tariffs". If orch is down or the user is typing, it is retried every minute.
- `worker` (default with a repo): orch starts a worker named `<name>-MMDD-HHMM` on the repo with the prompt as its task; done, gates and ship follow as for any worker. A full cap is retried every minute.
- `headless`: `claude -p` in the repo (or here) with read-only tools (`Tools:` overrides, e.g. `Read Grep Glob Bash(gh pr list:*)`). The answer goes to `notes/routines/<date>-<name>.md` and orch is told.

A slot missed by more than 12h (Mac asleep or off) is skipped, not run late. `state.json` holds each routine's last run and result.
