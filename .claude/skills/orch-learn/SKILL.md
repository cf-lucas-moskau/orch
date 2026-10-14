---
name: orch-learn
description: Review learning proposals in learned/. Use when the user says approve, edit or reject L<n>, asks what orch learned, or the morning brief lists learned items.
---

Files are `learned/<date>.md` (nightly) and `learned/<date>-weekly.md` (prune proposals), written by `npm run -s reflect` from launchd. Each item has Category, Target, Change, Source, State.

list: every item with State proposed, one line each with its date/id, category and title.

approve <date>/L<n>: verify the cited source still says that (read the transcript line), then apply Change to Target exactly. For a memory, also add or update its line in that MEMORY.md; for a delete, remove the file and its index line. Set State to approved, append to `log.md`. Writing outside orch's directory is allowed here because the user approved this item.

edit <id> <words>: apply the user's version instead, State approved (edited).

reject <id> [why]: State rejected with their reason; nothing else changes.

Categories listed as on under Auto-apply in `policies.md` are applied during the brief without asking, then reported. All other categories wait for the user.
