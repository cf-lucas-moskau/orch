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
