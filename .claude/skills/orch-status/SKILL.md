---
name: orch-status
description: Summarise what every agent session is doing. Use when the user asks what's going on, for status, the board, what needs them, or what a specific session is up to.
---

1. Run `npm run -s board` in orch's directory.
2. Answer as CLAUDE.md describes: blocked first, then sessions waiting on the user, then working, idle as a count.
3. For a specific session, also run `herdr agent read <pane_id>` and summarise the last screen in two lines.
