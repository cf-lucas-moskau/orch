// Pure parsing and timing for routines/<name>.md: recurring tasks launchd ticks every minute (orch tick).
import type { Live } from './dispatch.ts';

export type Mode = 'orch' | 'worker' | 'headless';
export type Schedule = { kind: 'at'; days: number[]; times: [number, number][] } | { kind: 'every'; ms: number };
export type Routine = { name: string; schedule: string; mode: Mode; repo: string; tools: string; paused: boolean; prompt: string };
export type RoutineState = { last?: string; result?: string; running?: number };

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SETS: Record<string, number[]> = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] };
// A daily or weekly slot missed by more than this (asleep, powered off) is skipped instead of run late.
export const MAX_LATE_MS = 12 * 36e5;

// "weekdays 08:30", "mon,thu 09:00,14:00", "daily 23:00", "every 2h", "every 30m".
export function parseSchedule(s: string): Schedule | null {
  const t = s.trim().toLowerCase();
  const every = t.match(/^every (\d+)\s*(m|min|h)$/);
  if (every) return +every[1] > 0 ? { kind: 'every', ms: +every[1] * (every[2] === 'h' ? 36e5 : 6e4) } : null;
  const m = t.match(/^(\S+) ((?:\d{1,2}:\d{2},?)+)$/);
  if (!m) return null;
  const days = SETS[m[1]] ?? m[1].split(',').map(d => DAYS.indexOf(d.slice(0, 3)));
  const times = m[2].split(',').filter(Boolean).map(x => x.split(':').map(Number) as [number, number]);
  if (days.some(d => d < 0) || times.some(([h, mi]) => h > 23 || mi > 59)) return null;
  return { kind: 'at', days, times };
}

// Worker names are capped at 32 characters and a run adds -MMDD-HHMM.
export const validRoutineName = (n: string) => /^[a-z][a-z0-9_-]{0,21}$/.test(n);

export function parseRoutine(md: string, name: string): Routine | null {
  if (!validRoutineName(name)) return null;
  const field = (k: string) => md.match(new RegExp(`^${k}:\\s*(.+)$`, 'mi'))?.[1].trim() ?? '';
  const prompt = md.split(/\n\s*\n/).slice(1).join('\n\n').trim();
  const repo = field('Repo');
  const mode = (field('Mode') || (repo ? 'worker' : 'orch')) as Mode;
  if (!parseSchedule(field('Schedule')) || !prompt || !['orch', 'worker', 'headless'].includes(mode) || (mode === 'worker' && !repo)) return null;
  return { name, schedule: field('Schedule'), mode, repo, tools: field('Tools'), paused: /^paused$/i.test(field('Status')), prompt };
}

export function renderRoutine(r: Routine): string {
  return [`# ${r.name}`, `Schedule: ${r.schedule}`, `Mode: ${r.mode}`, ...(r.repo ? [`Repo: ${r.repo}`] : []),
    ...(r.tools ? [`Tools: ${r.tools}`] : []), `Status: ${r.paused ? 'paused' : 'active'}`, '', r.prompt, ''].join('\n');
}

// The newest daily/weekly slot at or before now, looking back a week.
function lastSlot(s: Extract<Schedule, { kind: 'at' }>, now: Date): Date | null {
  for (let back = 0; back <= 7; back++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    if (!s.days.includes(day.getDay())) continue;
    const slots = s.times.map(([h, m]) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m))
      .filter(d => d <= now).sort((a, b) => b.getTime() - a.getTime());
    if (slots.length) return slots[0];
  }
  return null;
}

export function nextRun(s: Schedule, last: Date, now: Date): Date {
  if (s.kind === 'every') return new Date(Math.max(last.getTime() + s.ms, now.getTime()));
  for (let ahead = 0; ahead <= 7; ahead++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
    if (!s.days.includes(day.getDay())) continue;
    const slots = s.times.map(([h, m]) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m))
      .filter(d => d > now).sort((a, b) => a.getTime() - b.getTime());
    if (slots.length) return slots[0];
  }
  return now;
}

// What a tick does with one routine: run the slot, skip a slot missed by too much, or nothing.
export function due(s: Schedule, last: Date, now: Date): { run: Date } | { skip: Date } | null {
  if (s.kind === 'every') return now.getTime() - last.getTime() >= s.ms ? { run: now } : null;
  const slot = lastSlot(s, now);
  if (!slot || slot <= last) return null;
  return now.getTime() - slot.getTime() > MAX_LATE_MS ? { skip: slot } : { run: slot };
}

// Worker names carry the slot so each run gets its own branch.
export function runName(r: Routine, slot: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${r.name}-${p(slot.getMonth() + 1)}${p(slot.getDate())}-${p(slot.getHours())}${p(slot.getMinutes())}`;
}

// orch itself: the Claude session titled orch in orch's own folder (npm start names it).
export function orchPane(live: Live[], root: string): Live | undefined {
  return live.find(a => a.agent === 'claude' && a.terminal_title_stripped === 'orch' && a.cwd === root);
}
