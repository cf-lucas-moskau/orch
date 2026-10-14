import type { OrchMood, OrchState, WorkerView } from '../../src/state.ts';

export type { OrchState, WorkerView };
export type PetMood = OrchMood | 'asleep';

// A worker sprite's life on screen. Phases with an end time play once, then settle.
export type Phase = 'arriving' | 'here' | 'cheering' | 'leaving';
export type Sprite = { worker: WorkerView; phase: Phase; until: number };

export const ARRIVE_MS = 1400;
export const CHEER_MS = 2200;
export const LEAVE_MS = 1600;
export const STALE_MS = 60_000;

export function petMood(state: OrchState | null, now: number): PetMood {
  if (!state || now - Date.parse(state.ts) > STALE_MS) return 'asleep';
  return state.orch.state;
}

// Open decisions plus workers that ask something: what the badge counts.
export const waitingCount = (s: OrchState | null) =>
  s ? s.decisions.length + s.workers.filter(w => w.status === 'asking' || w.status === 'blocked').length : 0;

// prev === null is the first state after launch: show what exists without replaying arrivals.
export function reconcile(prev: Sprite[] | null, workers: WorkerView[], now: number): Sprite[] {
  const settle = (s: Sprite): Sprite | null =>
    s.until > now ? s : s.phase === 'leaving' ? null : { ...s, phase: 'here', until: 0 };
  if (!prev) return workers.map(worker => ({ worker, phase: 'here', until: 0 }));
  const live = new Map(workers.map(w => [w.name, w]));
  const out: Sprite[] = [];
  for (const s of prev) {
    const w = live.get(s.worker.name);
    const next: Sprite | null =
      !w ? (s.phase === 'leaving' ? s : { ...s, phase: 'leaving', until: now + LEAVE_MS })
      : w.status === 'done' && s.worker.status !== 'done' ? { worker: w, phase: 'cheering', until: now + CHEER_MS }
      : s.phase === 'leaving' ? { worker: w, phase: 'here', until: 0 }
      : { ...s, worker: w };
    const settled = next && settle(next);
    if (settled) out.push(settled);
    live.delete(s.worker.name);
  }
  for (const w of live.values()) out.push({ worker: w, phase: 'arriving', until: now + ARRIVE_MS });
  return out;
}

// Sprites for a new state. No state yet (launch, file missing) leaves them unknown, so the first real state
// shows its workers in place instead of replaying their arrivals.
export const nextSprites = (prev: Sprite[] | null, state: OrchState | null, now: number) =>
  state ? reconcile(prev, state.workers, now) : prev;

// When the view next changes on its own (a phase ends, the feed goes stale), so the renderer wakes once
// instead of running a loop. Only future moments count; a past one would re-fire forever.
export function nextWake(sprites: Sprite[], state: OrchState | null, now: number) {
  const stale = state ? Date.parse(state.ts) + STALE_MS + 1 : 0;
  return Math.min(...[...sprites.map(s => s.until), stale].filter(t => t > now));
}

// How fast the looping poses flip: off when nothing moves, slow for the sleeping pet's z's.
export function motionFps(mood: PetMood, sprites: Sprite[]) {
  if (mood === 'asleep') return 2;
  const busy = mood !== 'idle' || sprites.some(s => ['working', 'asking', 'blocked'].includes(s.worker.status));
  return busy ? 8 : 0;
}
