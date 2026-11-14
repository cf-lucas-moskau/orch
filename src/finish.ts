import { createHash } from 'node:crypto';
import type { FeedEvent } from './board.ts';
import { classify } from './triage.ts';

// Turn ends nobody answered yet: each session's last Stop or blocking Notification (a permission prompt or a
// question) with no prompt, Stop, StopFailure or SessionEnd after it. Built by replaying the feed like src/stall.ts,
// so one the watcher missed (written between a watcher's exit and its re-arm, or a Stop read as progress by triage)
// is still owed a line. The caller remembers which ones it said, by key.
export const QUIET_MS = 30 * 60_000;
export type Owed = { e: FeedEvent; key: string };
export type Finishes = Map<string, Owed>;

// The whole feed line, hashed: the hook's timestamps have second precision, so two events of one session can share one.
export const finishKey = (line: string) => createHash('sha1').update(line).digest('hex').slice(0, 16);

export function step(m: Finishes, e: FeedEvent, line: string) {
  if (e.event === 'Stop' || (e.event === 'Notification' && classify(e) === 'blocked')) m.set(e.sid, { e, key: finishKey(line) });
  else if (e.event === 'UserPromptSubmit' || e.event === 'StopFailure' || e.event === 'SessionEnd') m.delete(e.sid);
}

// The ones owed a line by now. A Stop triage reads as progress ("still running") is owed one only after QUIET_MS
// with nothing after it; the caller still checks the pane before calling it done.
export function due(m: Finishes, now: number): Owed[] {
  return [...m.values()].filter(({ e }) => classify(e) !== 'skip' || now - Date.parse(e.ts) >= QUIET_MS);
}
