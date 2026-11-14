# Playbooks

Two ways to use the setup from `AGENT-SETUP.md`, each worked through once. Names in angle brackets are from `~/.agent-setup.env`: `<HOST>` is the agent host's Tailscale name, `<MAIN>` the main Mac's.

Where to talk to which agent:

| You are | Talk to orch | Start a one-off agent on the host |
| --- | --- | --- |
| On the phone | Claude app, Code, session "orch" | Claude app, Code, environment `<HOST>` (the remote-control workspace), new session |
| At the main Mac | `herdr --remote <HOST>`, workspace `orch` | `bus send <HOST> "<subject>" "<request>"` from a Claude session or a terminal |
| Anywhere on the tailnet | the decision queue page, `http://<HOST>:7390` | |

Nothing in either playbook opens a browser or an app on the main Mac.

## A. Coding on the host with orch workers

The main Mac stays free; the host does the work in its own git worktrees and asks before anything leaves the machine.

### Once per repo
1. Tell orch: "add repo `<name>`: clone `<git url>` to ~/code/`<name>` and find its gates". orch clones it on the host and adds a row to `projects.md` with the commands that prove a change works (lint, tests, build).
2. On the main Mac, add the host as a git remote in your own clone (`AGENT-SETUP.md` S9.2), so worker branches can be read without pushing anywhere.

### Each task
1. **Ask.** To orch: `run my-app fix-login: the login button does nothing in Safari. Repro: ... Done when: ...`. Add `with both` for Claude and Codex on the same task when a miss would be expensive (auth, money, migrations).
2. **orch dispatches.** A worker starts in its own worktree on branch `orch/fix-login`, in poteto-mode if pstack is installed. Up to the concurrency cap from `local.md` run at once.
3. **Questions come to you.** A worker that needs a decision becomes `decisions/D-NN.md` with orch's recommendation, a push notification to the phone, and an entry on the queue page. Answer from anywhere: "accept D-3", "reject D-3, keep the old API", or the `a`/`r` keys on the queue page. orch types the answer into the worker.
4. **Gates and review.** When the worker reports done, orch runs the repo's gates. Pass: one commit on the worker branch, then a two-model review if Codex is set up (`review my-app orch/fix-login`). Fail: orch steers the worker once with the output; a second failure is a decision.
5. **Look at it.** On the main Mac: `git fetch agent-host` and `git diff main...agent-host/orch/fix-login`, or attach with `herdr --remote <HOST>` and read the worker's pane.
6. **Ship.** Pushing, opening the PR and merging are decisions by default ("push fix-login and open the PR"). Once you trust it, switch on `push`, `merge` and friends in `local.md` under Autonomy; the bars in `policies.md` still apply.
7. **Clean up.** "clean up fix-login" removes the worktree after the merge.

Every morning at 08:02 the `morning-brief` routine sends what moved overnight and what waits for you. Recurring work is a sentence away: "every weekday at 8:30, look at the PRs of my-app".

## B. Loose topics prepared on their own

Example: "make me five company presentations from my Obsidian vault". The host researches in the read-only vault copy (`~/Vault`), builds the decks, renders PDFs headless and drops them in the synced outbox. You read them in Finder or on the phone and answer with feedback.

### 1. Hand it over
Phone: open the Claude app, Code, environment `<HOST>`, new session. Main Mac, without leaving the terminal:

```bash
~/.claude/agent-bus/bin/bus send <HOST> "Five company decks" <<'EOF'
Make five short presentations, one per company: Acme, Globex, Initech, Umbrella, Stark.
Source: my Obsidian vault in ~/Vault (meeting notes, the company notes, anything that names them). Use only what is there; mark gaps.
Audience: our leadership team. Goal: decide where we invest next quarter. Tone: exec pitch, 6 to 8 slides each.
Use the present skill and the image-gen skill for visuals. Do not wait on me for the present skill's questions: answer them from the vault and this brief, and list open points on a last "Open questions" slide.
Render each deck to PDF with deck-to-pdf and put deck and PDF in ~/AgentOutbox/company-decks/. Check every PDF page yourself before you call it done.
When done, reply with the list of PDFs and the three things you are least sure about.
EOF
```

The body comes from stdin; the subject is the second argument.

The host's watcher starts a session for it within a minute, in herdr workspace `agent-bus` with Remote Control on: you can watch it from the phone (its name starts with `bus`).

### 2. What the host agent does
1. Reads the request (`bus --auto read <id>`), then searches `~/Vault` with grep for each company, and writes a short source list per company to `~/AgentOutbox/company-decks/<company>/sources.md`.
2. Builds each deck with the present skill into `~/AgentOutbox/company-decks/<company>/<company>-<date>.html`; visuals from image-gen, each one looked at before use.
3. Renders the PDF, headless, with no window anywhere:

   ```bash
   NODE_PATH=~/.local/share/deck-to-pdf/node_modules node ~/orch/docs/replicate/kit/deck-to-pdf.mjs \
     ~/AgentOutbox/company-decks/acme/acme-2026-11-20.html
   ```

4. Reads every PDF page (poppler is installed for that) and fixes clipped text, overlapping elements, empty slides or wrong names before it reports.
5. Replies over the bus: `bus --auto reply <id> "<PDF list, three doubts>"`. In a Remote Control session it also sends each PDF to the phone with SendUserFile.

### 3. Your feedback
The PDFs appear on the main Mac in `~/AgentOutbox/company-decks/` within seconds. Open them with Quick Look (space bar in Finder). Feedback goes back one of three ways:

- **On the phone**, in the same session: "Acme: slide 3 is too long, drop the market table. Stark: wrong CEO, it's ...".
- **In a file**: write `~/AgentOutbox/company-decks/feedback.md` (one heading per company), then `bus send <HOST> "Deck feedback" "Feedback is in ~/AgentOutbox/company-decks/feedback.md, apply it and re-render the PDFs."`.
- **In the PDF**: annotate in Preview, save, and say so in a bus message; the agent reads the annotations with poppler (`pdftotext`, and page images for the marks).

The agent applies it, re-renders, and replies again. Each round ends with fresh PDFs in the same folder.

### Other loose topics, same pattern
- "Summarise everything my vault says about <customer> into a two-page briefing PDF before Thursday."
- "Read these three PDFs in ~/AgentOutbox/inbox/ and draft an answer to <person>, as a .md, not sent."
- Recurring: tell orch "every Friday 16:00, collect this week's meeting notes from ~/Vault into a one-page PDF in ~/AgentOutbox/weekly/". That is a routine; launchd keeps it running across restarts.

Rules the host agent keeps for this kind of work: the vault is read-only (it is a receive-only copy, so edits would be reverted anyway); results go only to `~/AgentOutbox`; nothing is sent outside the two Macs (no mail, no Slack, no uploads) without asking.
