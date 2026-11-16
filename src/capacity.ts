// Leads keep their workers busy. Two watcher lines push them: IDLE when a lead builds under its limit while work
// waits, UNSHIPPED when a worker finished long ago and nothing shipped or cleaned it up. The watcher (src/watch.ts)
// does the IO and keeps the state in capacity.json; this decides.
import type { Idea } from './ideas.ts';
import { parsePlan } from './plan.ts';

export const IDLE_MS = 30 * 60_000;
export const UNSHIPPED_AFTER_MS = 45 * 60_000;
export const UNSHIPPED_EVERY_MS = 60 * 60_000;
export const LOW_DISK_GB = 20;
export const LOW_DISK_LIMIT = 3;
export const DEFAULT_LIMIT = 4;

// idle: when each lead last got an IDLE line. done: when each worker's last DONE line came, and when it was last
// told it is unshipped. All in ms.
export type Finished = { at: number; said?: number };
export type CapacityState = { idle: Record<string, number>; done: Record<string, Finished> };
export const EMPTY: CapacityState = { idle: {}, done: {} };

// The building limit: ideas/config.json building as written there (4 when unset, not the idea bridge's default of 1), at most 3 under 20 GB free, nothing under the Disk floor (orch run
// refuses then anyway). An unknown free space keeps the configured limit.
export function buildLimit(configured: number | undefined, freeGb: number | undefined, floorGb: number): number {
  const limit = configured && configured > 0 ? configured : DEFAULT_LIMIT;
  if (freeGb === undefined) return limit;
  if (freeGb < floorGb) return 0;
  return freeGb < LOW_DISK_GB ? Math.min(limit, LOW_DISK_LIMIT) : limit;
}

// Work a lead could start now: ideas with a go and a plan, and open tasks of the newest section of
// plans/<repo>.md that no running worker holds. Older sections are history; their leftover open boxes do not count.
export function waitingWork(ideas: Idea[], planMd: string, running: string[]): number {
  const approved = ideas.filter(i => i.state === 'approved' && !!i.plan).length;
  const last = planMd.lastIndexOf('\n## ');
  const held = new Set(running);
  const tasks = parsePlan(last < 0 ? planMd : planMd.slice(last)).tasks.filter(t => t.state === 'open' && !held.has(t.slug)).length;
  return approved + tasks;
}

export function idleLine(s: CapacityState, lead: string, building: number, limit: number, waiting: number, now: number): { state: CapacityState; line?: string } {
  if (building >= limit || waiting === 0 || now - (s.idle[lead] ?? 0) < IDLE_MS) return { state: s };
  return { state: { ...s, idle: { ...s.idle, [lead]: now } }, line: `IDLE lead ${lead}: building ${building}/${limit}, ${waiting} waiting` };
}

// A DONE line starts the clock again: the worker finished a newer turn.
export function noteDone(s: CapacityState, line: string, now: number): CapacityState {
  const name = line.match(/^DONE worker (\S+) /)?.[1];
  return name ? { ...s, done: { ...s.done, [name]: { at: now } } } : s;
}

// Workers no longer running were cleaned up: forgotten.
export function prune(s: CapacityState, running: Set<string>): CapacityState {
  return { ...s, done: Object.fromEntries(Object.entries(s.done).filter(([n]) => running.has(n))) };
}

// Finished over 45 minutes ago and not told within the last hour. The caller still checks the PR and the pane.
export const unshippedDue = (s: CapacityState, now: number) => Object.entries(s.done)
  .filter(([, f]) => now - f.at >= UNSHIPPED_AFTER_MS && (f.said === undefined || now - f.said >= UNSHIPPED_EVERY_MS))
  .map(([name]) => name);

export function unshipped(s: CapacityState, name: string, now: number): { state: CapacityState; line: string } {
  const f = s.done[name];
  return {
    state: { ...s, done: { ...s.done, [name]: { ...f, said: now } } },
    line: `UNSHIPPED worker ${name}: done ${Math.floor((now - f.at) / 60_000)} min ago, not shipped`,
  };
}

// A merged PR shipped it: forgotten until its next DONE.
export function shipped(s: CapacityState, name: string): CapacityState {
  const { [name]: _, ...done } = s.done;
  return { ...s, done };
}
