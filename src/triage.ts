import type { FeedEvent } from './board.ts';

// What a feed event means for the user. blocked and question are candidate decisions,
// done is FYI unless orch finds a question on the pane, skip is noise.
export type Kind = 'blocked' | 'question' | 'done' | 'skip';

// Only clear progress wording: a finished summary that mentions remaining nits or reviewers being in is done.
const INTERIM = /\bstill (running|waiting|working)\b|\bnow (re-?)?(checking|running|reviewing)\b|(^|[.!]\s+)waiting (on|for)\b/i;
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

// The agent's last words on a visible screen: everything from an empty input box down (the box, the status bar)
// and rule lines dropped, whitespace collapsed, the last 200 characters.
export function screenTail(screen: string): string {
  const lines = screen.split('\n');
  const box = lines.findLastIndex(l => /^\s*[❯›]\s*$/.test(l));
  return (box >= 0 ? lines.slice(0, box) : lines).filter(l => !/^[\s─━]*$/.test(l))
    .join(' ').replace(/\s+/g, ' ').trim().slice(-200);
}
