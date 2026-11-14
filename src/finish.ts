import type { FeedEvent } from './board.ts';
import { classify } from './triage.ts';

// Turn ends nobody answered yet: each session's last Stop or blocking Notification (a permission prompt or a
// question) with no prompt, Stop, StopFailure or SessionEnd after it. Built by replaying the feed like src/stall.ts,
// so one the watcher missed (written between a watcher's exit and its re-arm, or a Stop read as progress by triage)
// is still owed a line. The caller remembers which ones it said.
export const QUIET_MS = 30 * 60_000;
export type Finishes = Map<string, FeedEvent>;

export function step(m: Finishes, e: FeedEvent) {
  if (e.event === 'Stop' || (e.event === 'Notification' && classify(e) === 'blocked')) m.set(e.sid, e);
  else if (e.event === 'UserPromptSubmit' || e.event === 'StopFailure' || e.event === 'SessionEnd') m.delete(e.sid);
}

export const finishKey = (e: FeedEvent) => `${e.sid} ${e.ts}`;

// The ones owed a line by now. A Stop triage reads as progress ("still running") is owed one only after QUIET_MS
// with nothing after it: the background work it waited on would have woken the session by then.
export function due(m: Finishes, now: number): FeedEvent[] {
  return [...m.values()].filter(e => classify(e) !== 'skip' || now - Date.parse(e.ts) >= QUIET_MS);
}
