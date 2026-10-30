# ideas

The Discord idea bridge's ledger, local to this machine and not in git. Setup and the flow are in `docs/ideas.md`.

| Path | What |
| --- | --- |
| `config.json` | Adapter (`mock` or `discord`), channel, allowlist of user ids, `perDay`, `building`, `repo`, `liveUrl`. |
| `I-<n>.json` | One idea: author, sanitized text, state, plan, worker. |
| `refused.json` | Strangers already told no today; later messages from them are only logged. |
| `off` | Kill switch. While it exists the bridge answers "paused" and `orch idea start` refuses. |
| `mock/inbox.jsonl` | Fake posts from `orch idea fake`; `mock/inbox.seen` counts the ones handled. |
| `mock/outbox.jsonl` | Everything the bridge and orch posted while on the mock adapter. |
