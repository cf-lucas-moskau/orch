// Pure parsing for step 4: plans/<project>.md and the next tasks a planning pass may dispatch.
import type { Worker } from './dispatch.ts';

export type TaskState = 'open' | 'running' | 'done' | 'blocked';
// A trailing (codex) or (both) tag picks the worker kind; no tag means Claude.
export type TaskKind = 'claude' | 'codex' | 'both';
export type Task = { slug: string; text: string; state: TaskState; kind: TaskKind; line: number };
export type Plan = { project: string; goal: string; milestone: string; tasks: Task[] };

const MARK: Record<string, TaskState> = { ' ': 'open', '~': 'running', x: 'done', X: 'done', '!': 'blocked' };
const SYMBOL: Record<TaskState, string> = { open: ' ', running: '~', done: 'x', blocked: '!' };
const TASK = /^- \[([ ~xX!])\] ([a-z][a-z0-9_-]{0,31}): (.+)$/;

export function parsePlan(md: string): Plan {
  const lines = md.split('\n');
  const field = (k: string) => lines.find(l => l.startsWith(`${k}:`))?.slice(k.length + 1).trim() ?? '';
  const tasks = lines.flatMap((l, line) => {
    const m = l.match(TASK);
    if (!m) return [];
    const tag = m[3].match(/\s*\((codex|both)\)\s*$/);
    return [{ slug: m[2], text: (tag ? m[3].slice(0, tag.index) : m[3]).trim(), state: MARK[m[1]], kind: (tag?.[1] ?? 'claude') as TaskKind, line }];
  });
  return { project: lines.find(l => l.startsWith('# '))?.slice(2).trim() ?? '', goal: field('Goal'), milestone: field('Milestone'), tasks };
}

export function setTaskState(md: string, slug: string, state: TaskState): string {
  return md.split('\n').map(l => {
    const m = l.match(TASK);
    return m && m[2] === slug ? `- [${SYMBOL[state]}] ${slug}: ${m[3]}` : l;
  }).join('\n');
}

// Open tasks in file order, as many as free slots allow, skipping ones a worker already holds.
export function nextTasks(plan: Plan, workers: Worker[], cap: number): Task[] {
  const running = workers.filter(w => w.status === 'running');
  const free = Math.max(0, cap - running.length);
  const held = new Set(running.map(w => w.pair ?? w.name));
  const out: Task[] = [];
  let left = free;
  // A (both) task takes two slots.
  for (const t of plan.tasks.filter(t => t.state === 'open' && !held.has(t.slug))) {
    const need = t.kind === 'both' ? 2 : 1;
    if (need <= left) { out.push(t); left -= need; }
  }
  return out;
}
