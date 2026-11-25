# Claude seats

One login can hold a seat in several organizations (Tiki-institut, Tiki GmbH), and each seat has its own 5-hour and weekly limit. orch keeps every session on this Mac running by moving the shared login to whichever seat has room.

## How it works

All Claude Code sessions on this Mac use one login, the keychain item `Claude Code-credentials`, and re-read it every 30 seconds. Swapping that item moves every running session to another seat without a restart (tested 2026-11-25: orch's own pane showed the other seat's numbers within a minute).

Each seat has a store: a config dir in `~/.orch-accounts/<name>`, whose keychain item (`Claude Code-credentials-<8 hex of sha256(dir)>`, the name Claude Code itself uses for `CLAUDE_CONFIG_DIR`) holds that seat's login. The live item holds a copy of the active seat's login. A swap:

1. refuses if the live token is due for a refresh within 3 minutes (a session could write a new one mid-swap),
2. saves the live login back to the active seat's store (Claude rotates refresh tokens, so the store would be stale otherwise),
3. copies the target's store into the live item and its `oauthAccount` into `~/.claude.json`,
4. checks that the API takes the new token and `claude auth status` names the target; otherwise rolls both back.

While a seat is active its store is never used, so the two copies never refresh against each other.

The watcher (src/watch.ts, `checkAccounts`) reads usage from `GET /api/oauth/usage`, the numbers `/usage` shows: the active seat every 3 minutes with the live login, the others every 15 with their store (refreshing an expired store token through `claude auth status`, then a one-word `claude -p` if needed). It switches when the active seat passes 95% on either window and another seat is under 90% on both; it waits out a full window that resets within 15 minutes and never switches twice in 30 minutes.

## Logins

A login lasts about 30 days and cannot be renewed past that. claude.ai's sign-in page sits behind Cloudflare's bot check, which stops automated browsers, so a fresh login needs a person for 30 seconds:

1. `npm run -s orch -- account login <name>` starts `claude auth login` in a hidden herdr pane on the seat's store and prints the link.
2. Open it in a normal browser, pick the organization, Authorize, and copy the code.
3. `npm run -s orch -- account code <name> <code>` finishes it and checks the login belongs to the right organization. For the active seat it also replaces the live login.

The watcher says `ACCOUNT login due <name>` once a day from 5 days before a login ends, so this never happens during a switch.

## Commands

| Command | What |
| --- | --- |
| `account status` | Both seats' numbers, reset times, login expiry; reads them fresh |
| `account adopt <name>` | Make the seat that is live now a seat called `<name>` |
| `account login <name>` / `account code <name> <code>` | Log a seat in; a new name adds a seat |
| `account use <name>` | Switch by hand |

## Lines

| Line | Meaning |
| --- | --- |
| `ACCOUNT switched <a> -> <b> (...)` | The watcher switched; FYI |
| `ACCOUNT full: ...` | No seat has room; earliest reset named; at most hourly |
| `ACCOUNT login due <name>` / `login expired <name>` | Log in again (above); once a day |
| `ACCOUNT error: ...` | A read or switch failed; at most hourly per text |
