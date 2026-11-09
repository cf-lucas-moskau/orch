// The watcher's herdr side: each running worker's finishes and blocks, from `herdr agent wait`, merged with the hook
// feed so every transition is reported once. The feed knows more (a question, an interim stop that is no finish), so
// herdr reports a few seconds late and only for a stretch of work the feed left silent; a feed line for a stretch
// herdr already reported is dropped.
import type { FeedEvent } from './board.ts';

export type HerdrAgent = { agent_status?: string; state_change_seq?: number; completion_seq?: number };
export type HerdrReply = { result?: { agent?: HerdrAgent }; error?: { code: string; message?: string } };

// One worker. A segment is one stretch of work, opened when the worker starts working; at most one line reports how
// it ended. handled is the last settled state herdr reported or found covered, kept across watcher restarts.
export type Watch = { segment: number; workingSeq?: number; reported: number[]; handled?: string };
export const newWatch = (handled?: string): Watch => ({ segment: 0, reported: [], handled });

// done and idle are one finish (focusing a pane turns done into idle); completion_seq tells it from the next one.
export function settleKey(a: HerdrAgent): string | null {
  if (a.agent_status === 'blocked') return `blocked ${a.state_change_seq}`;
  if (a.agent_status === 'done' || a.agent_status === 'idle') return `settled ${a.completion_seq ?? a.state_change_seq}`;
  return null;
}

const mark = (w: Watch, segment: number): Watch => ({ ...w, reported: [...w.reported.filter(s => s > w.segment - 8), segment] });

export function working(w: Watch, a: HerdrAgent): Watch {
  if (a.state_change_seq !== undefined && a.state_change_seq === w.workingSeq) return w;
  return { ...w, segment: w.segment + 1, workingSeq: a.state_change_seq };
}

// A feed event from the worker. A prompt opens a segment; Stop and Notification end it, and print is false when
// herdr already reported this segment.
export function feedEvent(w: Watch, e: Pick<FeedEvent, 'event'>): { w: Watch; print: boolean } {
  if (e.event === 'UserPromptSubmit') return { w: { ...w, segment: w.segment + 1 }, print: true };
  if (e.event !== 'Stop' && e.event !== 'Notification') return { w, print: true };
  if (w.reported.includes(w.segment)) return { w, print: false };
  return { w: mark(w, w.segment), print: true };
}

// herdr saw the worker settle while segment was current; decided GRACE later, so the feed's line comes first.
export function herdrSettled(w: Watch, a: HerdrAgent, segment: number): { w: Watch; report: 'blocked' | 'done' | null } {
  const key = settleKey(a);
  if (!key || key === w.handled) return { w, report: null };
  const seen = { ...w, handled: key };
  if (w.reported.includes(segment)) return { w: seen, report: null };
  return { w: mark(seen, segment), report: a.agent_status === 'blocked' ? 'blocked' : 'done' };
}

export const GRACE = 5000, RETRY = 5000;
export type FollowDeps = {
  get: () => Promise<HerdrReply>;
  // until [] is herdr's settled wait (idle, done or blocked).
  wait: (until: string[]) => Promise<HerdrReply>;
  sleep: (ms: number) => Promise<void>;
  later: (ms: number, f: () => void) => void;
  watch: () => Watch;
  save: (w: Watch) => void;
  emit: (kind: 'blocked' | 'done', a: HerdrAgent) => void;
};

// Follows one worker until alive() turns false. Every round first looks at the current state, so a finish before the
// watcher found the worker, or one after a failed wait, still counts; the next wait starts right away while a
// settle waits out its grace. seed marks the state at start as handled without reporting it (first run, no history).
export async function follow(d: FollowDeps, alive: () => boolean, seed = false) {
  const settle = (a: HerdrAgent) => {
    const segment = d.watch().segment;
    d.later(GRACE, () => {
      const r = herdrSettled(d.watch(), a, segment);
      d.save(r.w);
      if (r.report) d.emit(r.report, a);
    });
  };
  const failed = async (r: HerdrReply) => {
    if (!r.error) return false;
    if (r.error.code !== 'timeout') await d.sleep(RETRY);
    return true;
  };
  while (alive()) {
    const now = await d.get();
    if (!alive()) return;
    const a = now.result?.agent;
    if (a && settleKey(a)) {
      if (seed) d.save({ ...d.watch(), handled: settleKey(a)! });
      else settle(a);
    }
    seed = false;
    if (now.error) { await failed(now); continue; }
    const w = await d.wait(['working']);
    if (!alive()) return;
    if (await failed(w)) continue;
    d.save(working(d.watch(), w.result?.agent ?? {}));
    const s = await d.wait([]);
    if (!alive()) return;
    if (await failed(s)) continue;
    settle(s.result?.agent ?? {});
  }
}
