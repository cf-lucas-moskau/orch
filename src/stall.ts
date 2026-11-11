import type { FeedEvent } from './board.ts';
import { classify } from './triage.ts';

// Stalled turns: a session's turn that ended on an API error (the StopFailure hook) or that has sat idle for IDLE_MS
// since its last prompt without a DONE, QUESTION or BLOCKED line. Built by replaying the feed in order, so a watcher
// re-armed every 30 minutes finds the same stalls again; the caller remembers which ones it already said.
export const IDLE_MS = 30 * 60_000;

type Turn = { since: string; cwd: string; prompt: string; last: string; idleAt?: number; settled: boolean };
// streak: stalls since the session last answered (DONE, QUESTION or BLOCKED). orch resumes on the first only.
type Session = { turn?: Turn; streak: number };
export type Stall = { sid: string; cwd: string; key: string; text: string; streak: number };
export type Stalls = Map<string, Session>;

const line = (s: string) => s.replace(/\s+/g, ' ').trim();

function stall(sid: string, s: Session, text: string): Stall {
  const t = s.turn!;
  t.settled = true;
  s.streak++;
  return { sid, cwd: t.cwd, key: `${sid} ${t.since}`, text: line(text).slice(-200), streak: s.streak };
}

// Applies one feed event; returns the stall it reveals, if any. Ticks up to the event's time first.
export function step(m: Stalls, e: FeedEvent): Stall[] {
  const out = tick(m, Date.parse(e.ts));
  if (!e.sid) return out;
  const s = m.get(e.sid) ?? { streak: 0 };
  m.set(e.sid, s);
  const t = s.turn;
  if (e.event === 'UserPromptSubmit') s.turn = { since: e.ts, cwd: e.cwd, prompt: e.prompt ?? '', last: '', settled: false };
  else if (e.event === 'SessionEnd') s.turn = undefined;
  else if (!t || t.settled) {
    if (e.event === 'Stop' || e.event === 'Notification') { if (classify(e) !== 'skip') s.streak = 0; }
  } else if (e.event === 'StopFailure') out.push(stall(e.sid, s, e.msg || 'API error'));
  else if (e.event === 'Stop' || e.event === 'Notification') {
    const kind = classify(e);
    if (kind !== 'skip') { t.settled = true; s.streak = 0; }
    else if (e.event === 'Stop') { t.last = e.tail || e.msg; t.idleAt = undefined; }
    else t.idleAt ??= Date.parse(e.ts);
  }
  return out;
}

// The turns that have sat idle IDLE_MS by now.
export function tick(m: Stalls, now: number): Stall[] {
  const out: Stall[] = [];
  for (const [sid, s] of m) {
    const t = s.turn;
    if (t && !t.settled && t.idleAt !== undefined && now - t.idleAt >= IDLE_MS)
      out.push(stall(sid, s, t.last ? t.last : `idle 30 min, no reply to: ${line(t.prompt).slice(0, 150)}`));
  }
  return out;
}

export const stallLine = (name: string, pane: string, st: Stall) =>
  `STALLED worker ${name} [${pane}] ${st.sid.slice(0, 8)}${st.streak > 1 ? ` (again, ${st.streak} in a row)` : ''}: ${st.text}`;
