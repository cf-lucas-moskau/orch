// Pure: the 08:00 morning brief from the ledger. What moved overnight, open decisions, plans, learned items.
import type { FeedEvent } from './board.ts';
import type { Worker } from './dispatch.ts';
import type { Plan } from './plan.ts';

export type Decision = { id: string; question: string; session: string; status: string };
export type Learned = { id: string; title: string; category: string; state: string };

export function parseDecision(md: string): Decision {
  const head = md.match(/^# (D-\d+): (.+)$/m);
  const field = (k: string) => md.match(new RegExp(`^- ${k}: (.+)$`, 'm'))?.[1].trim() ?? '';
  return { id: head?.[1] ?? '', question: head?.[2].trim() ?? '', session: field('Session'), status: field('Status') };
}

// orch and the leads both file decisions, so a number is claimed by creating its file, never by picking it and writing later.
export const nextDecisionNumber = (files: string[]) =>
  Math.max(0, ...files.map(f => Number(f.match(/^D-(\d+)\.md$/)?.[1] ?? 0))) + 1;

export const decisionSkeleton = (n: number, question: string, session: string, opened: string) =>
  `# D-${String(n).padStart(2, '0')}: ${question}\n\n- Session: ${session}\n- Opened: ${opened}\n- Status: open\n- Stakes: \n- Gates: \n\n## Options\n1. \n\n## Recommendation\n\n\n## Outcome\n\n`;

export function parseLearned(md: string): Learned[] {
  return md.split(/^(?=## L-\d+:)/m).slice(1).map(s => ({
    id: s.match(/^## (L-\d+):/)![1],
    title: s.match(/^## L-\d+: (.+)$/m)![1].trim(),
    category: s.match(/^- Category: (.+)$/m)?.[1].trim() ?? '',
    state: s.match(/^- State: (\w+)/m)?.[1] ?? 'proposed',
  }));
}

const oneLine = (s: string, n = 140) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

export function buildBrief(o: {
  date: string; feed: FeedEvent[]; since: string; names: Record<string, { name: string }>;
  decisions: Decision[]; plans: Plan[]; learned: Learned[]; workers: Worker[]; ideas?: string[];
}): string {
  const moved = new Map<string, FeedEvent>();
  for (const e of o.feed) if (e.ts >= o.since && e.event === 'Stop') moved.set(e.sid, e);
  const open = o.decisions.filter(d => d.status === 'open');
  const pending = o.learned.filter(l => l.state === 'proposed');
  const running = o.workers.filter(w => w.status === 'running');

  const out = [`# brief ${o.date}`, ''];
  out.push(`## Decisions waiting (${open.length})`, ...open.map(d => `${d.id} ${d.question} (${d.session})`), '');
  out.push(`## Moved overnight (${moved.size})`,
    ...[...moved.values()].map(e => `${o.names[e.sid]?.name ?? `${e.cwd.split('/').at(-1)} ${e.sid.slice(0, 4)}`}: ${oneLine(e.msg)}`), '');
  if (o.ideas) {
    // Feedback on a shipped idea gets its own list: it is easy to lose among new ideas.
    const feedback = o.ideas.filter(l => /^IDEA \S+ feedback /.test(l));
    if (feedback.length) out.push(`## Feedback waiting (${feedback.length})`, ...feedback, '');
    const rest = o.ideas.filter(l => !feedback.includes(l));
    out.push(`## Ideas waiting on orch (${rest.length})`, ...rest, '');
  }
  out.push(`## Workers (${running.length})`, ...running.map(w => `${w.name} on ${w.repo}: ${oneLine(w.task, 80)}`), '');
  out.push('## Plans', ...o.plans.map(p => {
    const c = (s: string) => p.tasks.filter(t => t.state === s).length;
    return `${p.project}: ${p.milestone || p.goal}. ${c('open')} open, ${c('running')} running, ${c('blocked')} blocked, ${c('done')} done`;
  }), '');
  out.push(`## Learned to review (${pending.length})`, ...pending.map(l => `${l.id} [${l.category}] ${l.title}`));
  return out.join('\n') + '\n';
}
