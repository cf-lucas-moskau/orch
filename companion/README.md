# orch companion

A small desktop pet that shows what orch is doing, so you don't have to read the orch chat. It floats in a screen corner, always on top, and clicks pass through everywhere except the pet, its workers and the panel.

The pet is orch. It is calm and blinks when idle, shows a thought bubble while thinking, conducts with its baton while working, waves with a badge when something waits on you (open decisions plus workers that ask), looks alarmed when blocked, and falls asleep in grey when the state feed is older than 60 s. Each running worker is a small helper bot: it types while working, cheers once when done, raises a hand with ? or ! when asking or blocked, and walks off when orch cleans it up. A new worker arrives as a spark from orch's baton.

Hover a bot for its name, repo and last line. Click the pet for workers, open decisions and orch's last actions. Drag the pet to move it; the position is remembered. Esc closes the panel.

## How it gets its state

On the orch machine, `npm run state` (repo root) writes `~/agent-bus/orch-state.json` every 3 s, atomically. Syncthing carries `~/agent-bus` to the other Mac, where the app watches that file. Install it as a launchd job with `npm run setup -- --state`. The file holds one-line summaries only: no prompts, no secrets, under 20 KB.

## Build

```sh
cd companion
npm install
npm run build && npx electron .   # run from source
npm test                          # sprite lifecycle and mood logic
npm run shoot                     # drive the real app through every state, PNGs in shots/
npm run package                   # out/Orch Companion-darwin-arm64/Orch Companion.app
npm run icon                      # regenerate build/icon.icns from the pet (needs Chrome)
```

`ORCH_STATE_FILE` overrides the state file path.

## First launch of the unsigned app

The app is ad-hoc signed, not notarized, so Gatekeeper blocks it when it arrives through a sync or download. Either clear the quarantine flag once:

```sh
xattr -dr com.apple.quarantine ~/Applications/"Orch Companion.app"
open ~/Applications/"Orch Companion.app"
```

or right-click the app in Finder, choose Open, and confirm. It has no Dock icon; quit it from Activity Monitor or with `pkill -f "Orch Companion"`. To start it at login, add it under System Settings, General, Login Items.
