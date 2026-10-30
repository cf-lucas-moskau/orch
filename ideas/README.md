# ideas

The Discord idea bridge's ledger, local to this machine and not in git. Setup and the flow are in `docs/ideas.md`.

| Path | What |
| --- | --- |
| `config.json` | Adapter (`mock` or `discord`), channel, allowlist of user ids, `perDay`, `building`, `repo`, `liveUrl`. |
| `I-<n>.json` | One idea: author, sanitized text, state, plan, worker, and every thread message in full. |
| `told.json` | Who heard a decline today (stranger, paused, daily limit); later messages from them are only logged. |
| `.lock` | The one lock every read-modify-write of `ideas/` takes, bridge and `orch idea` alike. A lock whose process is gone is taken over. |
| `discord-cursor.json` | Live adapter only: the last handled message id per channel and thread, where the bridge catches up from after a restart. |
| `off` | Kill switch. While it exists the bridge answers "paused" once a day per member, says nothing to strangers, and `orch idea start` refuses. |
| `mock/inbox.jsonl` | Fake posts from `orch idea fake`; `mock/inbox.seen` counts the ones handled. |
| `mock/outbox.jsonl` | Everything the bridge and orch posted while on the mock adapter. |
| `drafts/` | Plans and changelogs orch writes before posting them; the only files `orch idea` reads. |
