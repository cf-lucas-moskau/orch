import type { FeedEvent } from './board.ts';

// Stalled turns: a session's turn that ended on an API error (the StopFailure hook), or a prompt whose turn went idle
// (Claude's idle ping) without any Stop and stayed so IDLE_MS. Any Stop ends a turn: what it says is triage's call.
// Built by replaying the feed in order, so a watcher re-armed every 30 minutes finds the same stalls again; the
// caller remembers which ones it already said.
export const IDLE_MS = 30 * 60_000;

// blocked: on a permission prompt, so idle is no stall; a StopFailure after approval still is.
type Turn = { since: string; cwd: string; prompt: string; idleAt?: number; blocked: boolean; state: 'open' | 'ended' | 'stalled' };
// streak: stalls since the session's last Stop. orch resumes on the first only.
type Session = { turn?: Turn; streak: number; stall?: Stall };
export type Stall = { sid: string; cwd: string; key: string; text: string; streak: number };
export type Stalls = Map<string, Session>;

const line = (s: string) => s.replace(/\s+/g, ' ').trim();
const open = (e: FeedEvent, prompt: string): Turn => ({ since: e.ts, cwd: e.cwd, prompt, blocked: false, state: 'open' });

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
  const t = s.turn;
  if (e.event === 'UserPromptSubmit') s.turn = open(e, e.prompt ?? '');
  else if (e.event === 'SessionEnd') s.turn = undefined;
  else if (e.event === 'Stop') { if (t) t.state = 'ended'; s.streak = 0; }
  // A turn can start without a prompt (a SendMessage resume): a StopFailure after the last turn ended is a new stall.
  else if (e.event === 'StopFailure') { if (t?.state !== 'open') s.turn = open(e, ''); out.push(stall(e.sid, s, e.msg || 'API error')); }
  else if (e.event === 'Notification' && t?.state === 'open') {
    if (!/waiting for your input/.test(e.msg)) t.blocked = true;
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
      out.push(stall(sid, s, `idle 30 min, no reply to: ${line(t.prompt).slice(0, 150)}`));
  }
  return out;
}

// The stalls still current after a replay: sessions whose latest turn is stalled. Earlier stalls the feed shows were
// recovered from (a later prompt or Stop) are not.
export function replay(feed: FeedEvent[], now: number): { stalls: Stalls; current: Stall[] } {
  const m: Stalls = new Map();
  for (const e of feed) step(m, e);
  tick(m, now);
  return { stalls: m, current: [...m.values()].flatMap(s => s.turn?.state === 'stalled' && s.stall ? [s.stall] : []) };
}

export const stallLine = (name: string, pane: string, st: Stall) =>
  `STALLED worker ${name} [${pane}] ${st.sid.slice(0, 8)}${st.streak > 1 ? ` (again, ${st.streak} in a row)` : ''}: ${st.text}`;
