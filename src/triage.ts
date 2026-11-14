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

export type Speaker = { name: string; pane: string };
export type WorkerRec = { name: string; pane: string; sid?: string; worktree?: string; status: string };

// A worker with a session id is that session alone: anything else in its worktree (a headless claude -p, a helper)
// is not the worker. Its folder counts only while it has no session id (Codex, or herdr has not named it yet).
export const workerFor = (workers: WorkerRec[], sid: string, cwd: string) => workers.find(w => w.status === 'running'
  && (w.sid ? w.sid === sid : !!w.worktree && !!cwd && (cwd === w.worktree || cwd.startsWith(w.worktree + '/'))));

// Who a feed event is from: a running worker, else a session herdr shows (sessions.json). Undefined: orch knows no such session.
export function speaker(e: FeedEvent, workers: WorkerRec[], sessions: Record<string, Speaker>): Speaker | undefined {
  const w = workerFor(workers, e.sid, e.cwd);
  return w ? { name: `worker ${w.name}`, pane: w.pane } : sessions[e.sid];
}

// The watcher line for a feed event, or undefined when it needs nobody. Leads' turns end all day and they escalate
// through decisions/, so their DONE says nothing. A session orch does not know is a one-off run (a critic's
// claude -p, a script): its turns ending say nothing either; only a permission prompt, which a person must answer, is said.
export function feedLine(e: FeedEvent, workers: WorkerRec[], sessions: Record<string, Speaker>, leads: Set<string>): string | undefined {
  const kind = classify(e);
  if (kind === 'skip' || (kind === 'done' && leads.has(e.sid))) return;
  const s = speaker(e, workers, sessions);
  if (!s && kind !== 'blocked') return;
  const { name, pane } = s ?? { name: e.sid.slice(0, 8), pane: '?' };
  const text = (kind === 'done' ? e.msg.slice(0, 160) : (e.tail || e.msg).slice(-200)).replace(/\s+/g, ' ');
  return `${kind.toUpperCase()} ${name} [${pane}] ${e.sid.slice(0, 8)}: ${text}`;
}

// The agent's last words on a visible screen: everything from an empty input box down (the box, the status bar)
// and rule lines dropped, whitespace collapsed, the last 200 characters.
export function screenTail(screen: string): string {
  const lines = screen.split('\n');
  const box = lines.findLastIndex(l => /^\s*[❯›]\s*$/.test(l));
  return (box >= 0 ? lines.slice(0, box) : lines).filter(l => !/^[\s─━]*$/.test(l))
    .join(' ').replace(/\s+/g, ' ').trim().slice(-200);
}
