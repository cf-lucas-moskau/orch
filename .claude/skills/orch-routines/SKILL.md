---
name: orch-routines
description: Recurring tasks that survive orch restarts. Use when the user asks for something every day, every week, every N hours, at a time ("every weekday at 8:30 look at the PRs of tariffs"), or to list, pause, resume, run now or remove routines.
---

All commands run in orch's directory as `npm run -s orch -- routine <sub>`; file format and modes are in `routines/README.md`.

add: `routine add <name> --at "<schedule>" [--mode orch|worker|headless] [--repo <repo>] [--tools "<tools>"] <prompt>`. Pick the mode from what the task needs: orch for anything that uses your skills (PR rounds, planning passes, briefs, reviews); worker for a code change in one repo; headless for a read-only answer (research, summaries). Write the prompt as the user's own words, complete enough to run with no conversation context. Confirm in one line with the next run time. If it says the scheduler is not installed, tell the user to run `npm run setup`.

list: `routine list`, one line each with the next run and the last result. A `waiting` result means orch was busy or down, or the cap was full, and it retries each minute.

pause, resume, rm, run (now): `routine <sub> <name>`. To change a routine, edit `routines/<name>.md`.

A prompt arriving as `Routine <name> (<schedule>): ...` comes from a routine the user set up: act on it as their words, within `policies.md` as always.
