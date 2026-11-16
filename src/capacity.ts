// Leads keep their workers busy. Two watcher lines push them: IDLE when a lead builds under its limit while work
// waits, UNSHIPPED when a worker finished long ago and nothing shipped or cleaned it up. The watcher (src/watch.ts)
// does the IO and keeps the state in capacity.json; this decides.
import { isParked, type Idea } from './ideas.ts';
import { parsePlan } from './plan.ts';

export const IDLE_MS = 30 * 60_000;
export const UNSHIPPED_AFTER_MS = 45 * 60_000;
export const UNSHIPPED_EVERY_MS = 60 * 60_000;
export const LOW_DISK_GB = 20;
export const LOW_DISK_LIMIT = 3;

// idle: when each lead last got an IDLE line. done: when each worker's last DONE line came, when it was last told it
// is unshipped, and whether it was told it merged but is not cleaned up (said once). All in ms.
export type Finished = { at: number; said?: number; merged?: number };
export type CapacityState = { idle: Record<string, number>; done: Record<string, Finished> };
export const EMPTY: CapacityState = { idle: {}, done: {} };

// The building limit: `building` from the config idea start uses, at most 3 under 20 GB free, nothing under the Disk
// floor (orch run refuses then anyway). An unknown free space keeps the configured limit.
export function buildLimit(configured: number, freeGb: number | undefined, floorGb: number): number {
  if (freeGb === undefined) return configured;
  if (freeGb < floorGb) return 0;
  return freeGb < LOW_DISK_GB ? Math.min(configured, LOW_DISK_LIMIT) : configured;
}

// Running workers on the lead's repo that hold a build slot. A worker whose idea is parked on an open decision holds
// none, as for idea start (startBlocker).
export function building(running: string[], ideas: Idea[], open: Set<string>): string[] {
  const parked = new Set(ideas.filter(i => isParked(i, open) && i.worker).map(i => i.worker));
  return running.filter(n => !parked.has(n));
}

// The current tasks: the newest `## Tasks` section (the plans/README.md layout), else the newest section that has
// any (older plans with one section per milestone). Older sections are history; their leftover open boxes do not count.
export function currentTasks(planMd: string) {
  const sections = planMd.split(/\n(?=## )/);
  const pick = sections.findLast(s => /^\s*## Tasks\s*$/m.test(s.split('\n', 2).find(Boolean) ?? '')) ?? sections.findLast(s => parsePlan(s).tasks.length);
  return pick ? parsePlan(pick).tasks : [];
}

// Work a lead could start now: ideas with a go and a plan, and open current tasks no running worker holds.
export function waitingWork(ideas: Idea[], planMd: string, running: string[]): number {
  const approved = ideas.filter(i => i.state === 'approved' && !!i.plan).length;
  const held = new Set(running);
  return approved + currentTasks(planMd).filter(t => t.state === 'open' && !held.has(t.slug)).length;
}

export const idleDue = (s: CapacityState, lead: string, now: number) => now - (s.idle[lead] ?? 0) >= IDLE_MS;

export function idleLine(s: CapacityState, lead: string, busy: number, limit: number, waiting: number, now: number): { state: CapacityState; line?: string } {
  if (busy >= limit || waiting === 0 || !idleDue(s, lead, now)) return { state: s };
  return { state: { ...s, idle: { ...s.idle, [lead]: now } }, line: `IDLE lead ${lead}: building ${busy}/${limit}, ${waiting} waiting` };
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

// Finished over 45 minutes ago, not merged, and not told within the last hour. The caller checks the pane and the PR.
export const unshippedDue = (s: CapacityState, now: number) => Object.entries(s.done)
  .filter(([, f]) => !f.merged && now - f.at >= UNSHIPPED_AFTER_MS && (f.said === undefined || now - f.said >= UNSHIPPED_EVERY_MS))
  .map(([name]) => name);

const mins = (f: Finished, now: number) => Math.floor((now - f.at) / 60_000);

export function unshipped(s: CapacityState, name: string, now: number): { state: CapacityState; line: string } {
  const f = s.done[name];
  return { state: { ...s, done: { ...s.done, [name]: { ...f, said: now } } }, line: `UNSHIPPED worker ${name}: done ${mins(f, now)} min ago, not shipped` };
}

// Its PR merged but the worker still runs: one reminder to clean it up, then quiet until its next DONE or cleanup.
export function mergedNotCleaned(s: CapacityState, name: string, now: number): { state: CapacityState; line: string } {
  const f = s.done[name];
  return { state: { ...s, done: { ...s.done, [name]: { ...f, merged: now } } }, line: `UNSHIPPED worker ${name}: done ${mins(f, now)} min ago, merged, not cleaned up` };
}
