// Pure: turns orch's ledger (hook feed, sessions.json, workers.json, decisions/, log.md) into what
// orch deck draws. No claude-code imports, so npm test covers it alongside src/.

import type { FeedEvent, SessionInfo, Worker, Decision, Status, Stage, Node, BusKind, BusLine, FlowName, Flow, Deck } from '../types';
export type { FeedEvent, SessionInfo, Worker, Decision, Status, Stage, Node, BusKind, BusLine, FlowName, Flow, Deck } from '../types';

export const STAGES: readonly Stage[] = ['brief', 'work', 'gates', 'review', 'judge', 'push'];

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

// Feed lines are appended by other processes, so a half-written last line is normal.
export function parseFeed(text: string): FeedEvent[] {
  const out: FeedEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.sid === 'string' && typeof e.event === 'string')
        out.push({ ts: e.ts, sid: e.sid, event: e.event, cwd: e.cwd ?? '', prompt: clip(e.prompt ?? '', 200), msg: clip(e.msg ?? '', 240), tail: clip(e.tail ?? '', 300), agent: e.agent });
    } catch { /* partial line */ }
  }
  return out;
}

export function parseDecision(id: string, md: string): Decision {
  const field = (k: string) => md.match(new RegExp(`^- ${k}: (.*)$`, 'm'))?.[1]?.trim() ?? '';
  const rec = md.match(/## Recommendation\n+([^\n#]+)/)?.[1]?.trim() ?? '';
  return { id, question: md.match(/^# D-\d+: (.*)$/m)?.[1]?.trim() ?? id, status: field('Status').split(/\s/)[0] || 'open', session: field('Session'), opened: field('Opened'), recommendation: rec };
}

// workers.json keeps history; a name reused later is the same slot, so the last entry wins.
export function latestWorkers(ws: Worker[]): Worker[] {
  const by = new Map<string, Worker>();
  for (const w of ws) by.set(w.name, w);
  return [...by.values()];
}

// Same reading as src/triage.ts, kept local so the mod has no imports outside its folder.
const INTERIM = /still running|\bnow (re-?)?(checking|running|reviewing)\b|waiting on|remaining|reviewers? (is|are) (in|done)|lens (is in|finished)|\bis in\b/i;
const QUESTION = /\?\s*(`{3}\s*)?$|\?\s*\n|\b(should I|want me to|do you want|shall I|which (one|option))\b/i;
export function classify(e: FeedEvent): 'blocked' | 'question' | 'done' | 'skip' {
  if (e.event === 'Notification') return /waiting for your input/.test(e.msg) ? 'skip' : 'blocked';
  if (e.event !== 'Stop') return 'skip';
  const end = e.tail || e.msg;
  if (QUESTION.test(end.slice(-300))) return 'question';
  if (INTERIM.test(e.msg)) return 'skip';
  return 'done';
}

const IDLE_MS = 30 * 60_000;
export function statusOf(evs: FeedEvent[], now: number): Status {
  const last = evs.filter(e => classify(e) !== 'skip' || e.event === 'UserPromptSubmit').at(-1);
  if (!last) return 'idle';
  if (last.event === 'UserPromptSubmit') return 'working';
  const k = classify(last);
  if (k === 'blocked' || k === 'question') return k;
  return now - Date.parse(last.ts) > IDLE_MS ? 'idle' : 'done';
}

// The furthest step orch's log shows for this worker; brief until its session says anything.
export function stageOf(w: Worker, log: string[], evs: FeedEvent[]): Stage {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = esc(w.name), pair = w.pair ? esc(w.pair) : null;
  const after = log.filter(l => (l.match(/^- (\d{4}-\d\d-\d\d \d\d:\d\d)/)?.[1] ?? '') >= w.started.slice(0, 16));
  const has = (re: RegExp) => after.some(l => re.test(l));
  if (has(new RegExp(`^- \\S+ \\S+ push ${name}:`))) return 'push';
  if (pair && has(new RegExp(`^- \\S+ \\S+ judge ${pair}:`))) return 'judge';
  if (has(new RegExp(`^- \\S+ \\S+ review \\S+ .*${esc(w.branch)}`))) return 'review';
  if (has(new RegExp(`^- \\S+ \\S+ gates ${name}:`))) return 'gates';
  return evs.length ? 'work' : 'brief';
}

const FLOW_OF: Record<string, FlowName> = {
  run: 'dispatch', steer: 'dispatch', gates: 'dispatch', cleanup: 'dispatch', workers: 'dispatch', restore: 'dispatch',
  review: 'review', judge: 'review', prs: 'prs', address: 'prs', 'post-review': 'prs', push: 'prs',
  continue: 'continue', brief: 'continue', reflect: 'learn', board: 'status',
};

// log.md lines look like "- 2026-10-09 10:12 run admin-fix (claude) on tariffs ...".
export function flowsFromLog(log: string[]): Flow[] {
  const out: Flow[] = [];
  for (const l of log) {
    const m = l.match(/^- (\d{4}-\d\d-\d\d \d\d:\d\d) (\S+)(.*)$/);
    if (!m) continue;
    const [, ts = '', word = '', rest = ''] = m;
    const cmd = word.replace(/:$/, '');
    const flow = FLOW_OF[cmd] ?? (/^D-\d+|Opened D-\d+/.test(cmd + rest) ? 'decisions' : null);
    if (flow) out.push({ ts, flow, detail: clip(oneLine(`${word}${rest}`), 140) });
  }
  return out;
}

// What orch is doing right now, read from its own tool calls.
export function flowFromCall(tool: string, input: Record<string, unknown>): { flow: FlowName; detail: string } | null {
  if (tool === 'Skill' && typeof input.skill === 'string') {
    const s = input.skill.replace(/^orch-/, '');
    const flow = ({ decisions: 'decisions', dispatch: 'dispatch', review: 'review', prs: 'prs', continue: 'continue', learn: 'learn', status: 'status' } as Record<string, FlowName>)[s];
    return flow ? { flow, detail: `skill ${input.skill}` } : null;
  }
  if (tool === 'Bash' && typeof input.command === 'string') {
    const m = input.command.match(/npm run -s (orch|board)(?: -- (\S+)(.*))?/);
    if (!m) return null;
    const cmd = m[1] === 'board' ? 'board' : m[2] ?? '';
    const flow = FLOW_OF[cmd];
    return flow ? { flow, detail: clip(oneLine(`${cmd}${m[3] ?? ''}`), 120) } : null;
  }
  return null;
}

export function busOf(e: FeedEvent, name: string): BusLine | null {
  if (e.event === 'UserPromptSubmit') {
    if (e.prompt.startsWith('<task-notification>')) return null;
    const p = oneLine(e.prompt.replace(/<agent-message[^>]*>/g, 'message: ').replace(/<[^>]+>/g, ''));
    if (!p) return null;
    return { ts: e.ts, sid: e.sid, name, kind: 'prompt', text: clip(p, 160) };
  }
  const k = classify(e);
  if (k === 'skip') return null;
  const text = clip(oneLine(k === 'question' ? (e.tail || e.msg).slice(-200) : e.msg), 160);
  return { ts: e.ts, sid: e.sid, name, kind: k === 'done' ? 'relay' : 'needs', text };
}

const RANK: Record<Status, number> = { blocked: 0, question: 1, working: 2, done: 3, idle: 4 };

export function buildDeck(input: {
  feed: FeedEvent[]; sessions: Record<string, SessionInfo>; workers: Worker[]; decisions: Decision[]; log: string[];
  now: number; selfCwd: string; liveFlows?: Flow[];
}): Deck {
  const { feed, sessions, now, selfCwd } = input;
  const bySid = new Map<string, FeedEvent[]>();
  for (const e of feed) if (e.cwd !== selfCwd) (bySid.get(e.sid) ?? bySid.set(e.sid, []).get(e.sid)!).push(e);
  for (const evs of bySid.values()) evs.sort((a, b) => a.ts.localeCompare(b.ts));
  const workers = latestWorkers(input.workers).filter(w => w.status === 'running');
  const workerBySid = new Map(workers.map(w => [w.sid, w]));

  const sids = new Set([...bySid.keys(), ...workers.map(w => w.sid)]);
  const nameOf = (sid: string) => workerBySid.get(sid)?.name ?? sessions[sid]?.name ?? sid.slice(0, 8);
  const all: Node[] = [...sids].map(sid => {
    const evs = bySid.get(sid) ?? [];
    const w = workerBySid.get(sid);
    const last = evs.at(-1);
    const said = [...evs].reverse().find(e => e.event === 'Stop');
    const kind = (w?.kind ?? last?.agent ?? sessions[sid]?.kind) === 'codex' ? 'codex' : 'claude';
    return {
      sid, name: nameOf(sid), pane: w?.pane ?? sessions[sid]?.pane ?? '', kind,
      status: w && !evs.length ? 'working' : statusOf(evs, now),
      lastTs: last?.ts ?? '', lastEvent: last?.event ?? '', said: said ? clip(oneLine(said.msg), 160) : '',
      worker: w ? { repo: w.repo, branch: w.branch, task: clip(oneLine(w.task), 200), stage: stageOf(w, input.log, evs), pair: w.pair ?? null, started: w.started } : null,
    };
  });
  const shown = all.filter(n => n.worker || n.status !== 'idle')
    .sort((a, b) => Number(!a.worker) - Number(!b.worker) || RANK[a.status] - RANK[b.status] || b.lastTs.localeCompare(a.lastTs));

  const bus = feed.filter(e => e.cwd !== selfCwd).map(e => busOf(e, nameOf(e.sid))).filter((b): b is BusLine => !!b)
    .sort((a, b) => a.ts.localeCompare(b.ts)).slice(-60);
  const flows = [...flowsFromLog(input.log).slice(-30), ...(input.liveFlows ?? [])].slice(-30);
  return { nodes: shown, idle: all.length - shown.length, bus, decisions: input.decisions.filter(d => d.status === 'open'), flows };
}

// An edge from orch to a session. While traffic is fresh a dot travels along it:
// outward for a prompt orch (or the user) sent, back toward orch for a reply.
export const PULSE_MS = 20_000;
export function edge(len: number, n: Pick<Node, 'lastTs' | 'lastEvent'>, now: number, tick: number): { text: string; isLive: boolean } {
  const age = n.lastTs ? now - Date.parse(n.lastTs) : Infinity;
  if (!(age < PULSE_MS)) return { text: `${'─'.repeat(len)}▶`, isLive: false };
  const out = n.lastEvent === 'UserPromptSubmit';
  const at = tick % len;
  const pos = out ? at : len - 1 - at;
  return { text: `${'━'.repeat(pos)}●${'━'.repeat(len - 1 - pos)}${out ? '▶' : '◀'}`, isLive: true };
}

export const stageBar = (s: Stage) => {
  const i = STAGES.indexOf(s);
  return { done: '■'.repeat(i), now: '■', todo: '□'.repeat(STAGES.length - 1 - i) };
};

export function ago(ts: string, now: number): string {
  if (!ts) return '';
  const m = Math.floor((now - Date.parse(ts)) / 60_000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(m / 1440)}d`;
}

export const hhmm = (ts: string) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts.slice(11, 16) : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function statusLine(d: Deck): string {
  const working = d.nodes.filter(n => n.status === 'working').length;
  const needs = d.nodes.filter(n => n.status === 'blocked' || n.status === 'question').length + d.decisions.length;
  const parts = [`${working} working`, needs ? `${needs} need you` : null, d.decisions[0] ? d.decisions.map(x => x.id).join(' ') : null];
  return `orch · ${parts.filter(Boolean).join(' · ')}`;
}

// The prompts the deck's buttons hand orch. The user pressed the key, so they go in as their words.
export const actions = {
  steer: (name: string, text: string) => `Steer ${name}: ${text}`,
  gates: (name: string) => `Run the gates for worker ${name} and tell me the result.`,
  cleanup: (name: string) => `Clean up worker ${name} if policy allows; otherwise tell me what blocks it.`,
  accept: (d: Decision) => `${d.id}: yes, go with your recommendation.`,
  reject: (d: Decision) => `${d.id}: no, `,
};
