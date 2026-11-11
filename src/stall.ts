import type { FeedEvent } from './board.ts';
import { classify } from './triage.ts';

// Stalled turns: a session's turn that ended on an API error (the StopFailure hook) or that has sat idle for IDLE_MS
// since its last prompt without a DONE or QUESTION line. Built by replaying the feed in order, so a watcher re-armed
// every 30 minutes finds the same stalls again; the caller remembers which ones it already said.
export const IDLE_MS = 30 * 60_000;

// open: working or idle; answered: ended on DONE or QUESTION; stalled: s.stall says why.
// blocked: on a permission prompt, so idle is no stall; any later turn event clears it.
type Turn = { since: string; cwd: string; prompt: string; last: string; idleAt?: number; blocked: boolean; state: 'open' | 'answered' | 'stalled' };
// streak: stalls since the session last answered. orch resumes on the first only.
type Session = { turn?: Turn; streak: number; stall?: Stall };
export type Stall = { sid: string; cwd: string; key: string; text: string; streak: number };
export type Stalls = Map<string, Session>;

const line = (s: string) => s.replace(/\s+/g, ' ').trim();
const open = (e: FeedEvent, prompt: string): Turn => ({ since: e.ts, cwd: e.cwd, prompt, last: '', blocked: false, state: 'open' });

function stall(sid: string, s: Session, text: string): Stall {
  const t = s.turn!;
  t.state = 'stalled';
  s.streak++;
  s.stall = { sid, cwd: t.cwd, key: `${sid} ${t.since}`, text: line(text).slice(-200), streak: s.streak };
  return s.stall;
}

// Applies one feed event; returns the stalls it reveals. Ticks up to the event's time first.
export function step(m: Stalls, e: FeedEvent): Stall[] {
  const out = tick(m, Date.parse(e.ts));
  if (!e.sid) return out;
  const s = m.get(e.sid) ?? { streak: 0 };
  m.set(e.sid, s);
  if (e.event === 'UserPromptSubmit') { s.turn = open(e, e.prompt ?? ''); return out; }
  if (e.event === 'SessionEnd') { s.turn = undefined; return out; }
  // A turn can start without a prompt (a background completion, a SendMessage): a Stop or StopFailure after the
  // last turn ended opens a new one, so a resumed worker that stalls again counts as again.
  if ((e.event === 'Stop' || e.event === 'StopFailure') && s.turn?.state !== 'open') s.turn = open(e, '');
  const t = s.turn;
  if (!t || t.state !== 'open') return out;
  if (e.event === 'StopFailure') out.push(stall(e.sid, s, e.msg || 'API error'));
  else if (e.event === 'Stop') {
    t.blocked = false;
    t.idleAt = undefined;
    if (classify(e) === 'skip') t.last = e.tail || e.msg;
    else { t.state = 'answered'; s.streak = 0; }
  } else if (e.event === 'Notification') {
    if (classify(e) === 'blocked') t.blocked = true;
    else if (!t.blocked) t.idleAt ??= Date.parse(e.ts);
  }
  return out;
}

// The turns that have sat idle IDLE_MS by now.
export function tick(m: Stalls, now: number): Stall[] {
  const out: Stall[] = [];
  for (const [sid, s] of m) {
    const t = s.turn;
    if (t?.state === 'open' && !t.blocked && t.idleAt !== undefined && now - t.idleAt >= IDLE_MS)
      out.push(stall(sid, s, t.last ? t.last : `idle 30 min, no reply to: ${line(t.prompt).slice(0, 150)}`));
  }
  return out;
}

// The stalls still current after a replay: sessions whose latest turn is stalled. Earlier stalls the feed shows were
// recovered from (a later prompt or answer) are not.
export function replay(feed: FeedEvent[], now: number): { stalls: Stalls; current: Stall[] } {
  const m: Stalls = new Map();
  for (const e of feed) step(m, e);
  tick(m, now);
  return { stalls: m, current: [...m.values()].flatMap(s => s.turn?.state === 'stalled' && s.stall ? [s.stall] : []) };
}

export const stallLine = (name: string, pane: string, st: Stall) =>
  `STALLED worker ${name} [${pane}] ${st.sid.slice(0, 8)}${st.streak > 1 ? ` (again, ${st.streak} in a row)` : ''}: ${st.text}`;
