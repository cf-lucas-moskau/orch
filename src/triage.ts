import type { FeedEvent } from './board.ts';

// What a feed event means for the user. blocked and question are candidate decisions,
// done is FYI unless orch finds a question on the pane, skip is noise.
export type Kind = 'blocked' | 'question' | 'done' | 'skip';

const INTERIM = /still running|\bnow (re-?)?(checking|running|reviewing)\b|waiting on|remaining|reviewers? (is|are) (in|done)|lens (is in|finished)|\bis in\b/i;
const QUESTION = /\?\s*(`{3}\s*)?$|\?\s*\n|\b(should I|want me to|do you want|shall I|which (one|option))\b/i;

export function classify(e: FeedEvent): Kind {
  if (e.event === 'Notification') return /waiting for your input/.test(e.msg) ? 'skip' : 'blocked';
  if (e.event !== 'Stop') return 'skip';
  const end = e.tail || e.msg;
  if (QUESTION.test(end.slice(-300))) return 'question';
  // Background completions often skip UserPromptSubmit, so progress wording alone decides.
  if (INTERIM.test(e.msg)) return 'skip';
  return 'done';
}

// The watcher hears a worker settle twice: from the hook feed and from `herdr agent wait`. The feed knows more (a
// question, an interim stop that is no finish), so it wins: every worker Stop or Notification is marked, and herdr's
// report, checked a few seconds after herdr saw the state, only prints when the feed said nothing within the window.
export type Seen = Map<string, number>;
const transition = (worker: string, blocked: boolean) => `${worker} ${blocked ? 'blocked' : 'settled'}`;
export function markFeed(seen: Seen, worker: string, e: Pick<FeedEvent, 'event'>, now: number) {
  if (e.event === 'Stop' || e.event === 'Notification') seen.set(transition(worker, e.event === 'Notification'), now);
}
// The agent's last words on a visible screen: everything from an empty input box down (the box, the status bar)
// and rule lines dropped, whitespace collapsed, the last 200 characters.
export function screenTail(screen: string): string {
  const lines = screen.split('\n');
  const box = lines.findLastIndex(l => /^\s*[❯›]\s*$/.test(l));
  return (box >= 0 ? lines.slice(0, box) : lines).filter(l => !/^[\s─━]*$/.test(l))
    .join(' ').replace(/\s+/g, ' ').trim().slice(-200);
}

export function herdrReport(seen: Seen, worker: string, status: string, now: number, windowMs = 30_000): 'blocked' | 'done' | null {
  const kind = status === 'blocked' ? 'blocked' : status === 'done' || status === 'idle' ? 'done' : null;
  if (!kind) return null;
  const key = transition(worker, kind === 'blocked');
  if (now - (seen.get(key) ?? -Infinity) < windowMs) return null;
  seen.set(key, now);
  return kind;
}
