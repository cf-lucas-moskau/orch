---
name: orch-dispatch
description: Start, steer, check and clean up worker sessions. Use for /orch run <task>, when the user asks for work with Codex or with both models, when a worker reports done or blocked, to relay an answer into a session, or to close finished work.
---

All commands run in orch's directory as `npm run -s orch -- <command>`; rules are in `policies.md` under Relay and steering, Workers, and Claude, Codex and pairs.

run: `run <repo> <name> [task] [--kind claude|codex|both] [--from <ref>]`. Claude workers start in poteto-mode automatically; their full brief is written to `briefs/<name>.md`. `<repo>` is a registered name, a path, or a folder under the code dir (`ORCH_CODE_DIR`, default ~/code). Kind: what the user said ("with Codex" is codex, "both" or "duel" is both), else the plan task's tag, else claude; tag `(both)` yourself for the risky task types in `policies.md`. Without a task, the text comes from the `<name>` task in `plans/<repo>.md`. Both starts `<name>-cl` and `<name>-cx`. Tell the user names and panes in one line. If it says not ready, read the pane and file a decision.

done: a `DONE worker <name>` line from the watcher. For a pair worker, wait until both are done, then `judge <pair>`: report the winner and why, mark the plan task `[x]`, ship the winner as below, and file a decision for abandoning the loser. For a single worker, run `gates <name>`; on a pass it makes the worker's commit. Pass: mark the plan task `[x]`, one FYI line, then ship. Fail: `steer <name>` once with the failing tail; a second fail is a decision.

ship (Autonomy in `policies.md`): `review <repo> <branch>` and verify single-model findings. A surviving blocking finding: steer the worker once to fix it, then gates and review again; still blocking is a decision. Clean: `push <name>`, then `open-pr <name>` for a new branch (a `pr<n>` worker updates its PR by the push). Then `merge <repo> <n>`; if checks are pending, retry on the next planning pass or brief. Any command refusing because its switch is off: file a decision and rerun with `--accepted D-NN` after the accept. Never ship work that touches deploys or databases; that stays a decision.

blocked or question from a worker: same as any session, a decision. Answer only with the user's words.

steer: `steer <name|pane> "<text>"`. For a new substantial task in one of the user's sessions, start the text with `/pstack:poteto-mode ` and keep it on one line (a newline turns it into pasted text and the slash command never runs). Use SendMessage instead when the session is a ListAgents peer (match by session id in `sessions.json`). It refuses focused and blocked panes; leave those alone and tell the user.

cleanup: `cleanup <name>` once the work is merged or abandoned. A refusal lists the unsaved work; file a decision, and only after the user agrees run `cleanup <name> --abandon`. The branch is always kept.

workers: `workers` lists running workers with live status and the cap.
