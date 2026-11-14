import type { FeedEvent } from './board.ts';

// What a feed event means for the user. blocked and question are candidate decisions,
// done is FYI unless orch finds a question on the pane, skip is noise.
export type Kind = 'blocked' | 'question' | 'done' | 'skip';

// Only wording that says the turn waits on something. Bare "is in" and "remaining" read final reports ("Q3 is in
// place", "no remaining failures") as progress and dropped their DONE.
const INTERIM = /still running|\bnow (re-?)?(checking|running|reviewing)\b|waiting on|will notify|reviewers? (is|are) (in|done)|lens (is in|finished)/i;
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
  && (w.sid ? w.sid === sid : inside(cwd, w.worktree)));

// The running worker whose worktree holds cwd, whatever session is talking there.
export const workerIn = (workers: WorkerRec[], cwd: string) => workers.find(x => x.status === 'running' && inside(cwd, x.worktree));

const inside = (cwd: string, dir?: string) => !!dir && !!cwd && (cwd === dir || cwd.startsWith(dir + '/'));

// The watcher line for a feed event, or undefined when it needs nobody. Leads' turns end all day and they escalate
// through decisions/, so their DONE says nothing. Another session id in a worker's worktree (a critic's claude -p, or
// the worker itself after a /clear) is not a finished worker, so its DONE says nothing; its prompts and questions
// still need the user and are said under the worker's name.
// kind overrides triage's reading, for a finish the watcher owes a line anyway (src/finish.ts).
export function feedLine(e: FeedEvent, workers: WorkerRec[], sessions: Record<string, Speaker>, leads: Set<string>, kind = classify(e)): string | undefined {
  if (kind === 'skip' || (kind === 'done' && leads.has(e.sid))) return;
  const w = workerFor(workers, e.sid, e.cwd);
  const host = w ? undefined : workerIn(workers, e.cwd);
  if (host && kind === 'done') return;
  const at = w ?? (sessions[e.sid] ? undefined : host);
  const { name, pane } = at ? { name: `worker ${at.name}`, pane: at.pane } : sessions[e.sid] ?? { name: e.sid.slice(0, 8), pane: '?' };
  const text = (kind === 'done' ? e.msg.slice(0, 160) : (e.tail || e.msg).slice(-200)).replace(/\s+/g, ' ');
  // Workers' helper subagents end with an empty DONE from a session orch doesn't know; nothing to act on.
  if (kind === 'done' && !text.trim() && pane === '?') return;
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
