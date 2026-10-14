import type { Agent, FeedEvent, Snapshot } from './board.ts';
import { classify } from './triage.ts';

// The snapshot orch companion renders. Written to ~/agent-bus/orch-state.json and synced to the work Mac,
// so it carries no prompts and no secrets, only one-line summaries.
export type OrchMood = 'idle' | 'thinking' | 'working' | 'waiting' | 'blocked';
export type WorkerStatus = 'working' | 'idle' | 'done' | 'blocked' | 'asking';
export type WorkerView = { name: string; repo: string; kind: string; status: WorkerStatus; said: string; started: string };
export type OrchState = {
  v: 1;
  ts: string;
  orch: { state: OrchMood; said: string };
  workers: WorkerView[];
  decisions: { id: string; question: string }[];
  sessions: Record<string, number>;
  actions: string[];
};

export type WorkerRecord = { name: string; repo: string; kind?: string; status: string; sid?: string; pane?: string; worktree?: string; started?: string };
export type Decision = { id: string; status: string; question: string };

const THINKING_MS = 20_000;
const MAX_WORKERS = 12;

// The state file leaves this machine, so anything shaped like a credential is masked before it is clipped.
const SECRETS: [RegExp, string][] = [
  [/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|bearer|client[_-]?secret)(\s*[:=]\s*|\s+)(["']?)[^\s"',;]{4,}\3/gi, '$1$2[redacted]'],
  [/\b(sk-(?:ant-|proj-)?|ATATT|gh[pousr]_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza)[A-Za-z0-9_\-=]{8,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[redacted]'],
  [/\b[0-9a-f]{32,}\b/gi, '[redacted]'],
];
// Long random-looking runs (base64, opaque tokens): mixed case with several digits, unlike words, ids and paths.
const opaque = (w: string) => (w.match(/\d/g)?.length ?? 0) >= 4 && /[A-Z]/.test(w) && /[a-z]/.test(w);
export const redact = (s: string) => SECRETS.reduce((t, [re, by]) => t.replace(re, by), s)
  .replace(/[A-Za-z0-9+_=-]{32,}/g, w => opaque(w) ? '[redacted]' : w);
const clip = (s: string, n: number) => {
  const t = redact(s.replace(/\s+/g, ' ').trim());
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
// The last thing a session said: the final non-empty line of its last reply, stripped of markdown noise.
const lastLine = (e: FeedEvent | undefined) => {
  const lines = (e?.tail || e?.msg || '').split('\n').map(l => l.replace(/[*`#>]/g, '').trim()).filter(Boolean);
  return clip(lines.at(-1) ?? '', 120);
};

export function parseDecision(id: string, text: string): Decision {
  return {
    id,
    status: /^- Status:\s*(\w+)/m.exec(text)?.[1] ?? 'open',
    question: /^# D-\d+:\s*(.*)$/m.exec(text)?.[1] ?? '',
  };
}

export function lastActions(log: string, n = 5): string[] {
  // Log lines look like "- 2026-10-14 15:58 cleanup zolt144: ..."; keep the time, drop the date.
  return log.split('\n').filter(l => /^- \d{4}-\d\d-\d\d \d\d:\d\d /.test(l)).slice(-n)
    .map(l => clip(l.slice(13), 120));
}

// orch is the herdr agent named orch; otherwise the session in the orch workspace that spoke last.
export function findOrch(snap: Snapshot, feed: FeedEvent[]): Agent | undefined {
  const named = snap.agents.find(a => a.name === 'orch');
  if (named) return named;
  const ws = new Set(snap.workspaces.filter(w => w.label === 'orch').map(w => w.workspace_id));
  const lastTs = (a: Agent) => feed.filter(e => e.sid === a.agent_session?.value).at(-1)?.ts ?? '';
  return snap.agents.filter(a => ws.has(a.workspace_id)).sort((x, y) => lastTs(y).localeCompare(lastTs(x)))[0];
}

export function buildState(input: {
  snap: Snapshot; feed: FeedEvent[]; workers: WorkerRecord[]; decisions: Decision[]; log: string; now: number;
}): OrchState {
  const { snap, feed, now } = input;
  const bySid = new Map<string, FeedEvent[]>();
  for (const e of [...feed].sort((x, y) => x.ts.localeCompare(y.ts))) (bySid.get(e.sid) ?? bySid.set(e.sid, []).get(e.sid)!).push(e);
  const lastStop = (sid?: string) => sid ? bySid.get(sid)?.filter(e => e.event === 'Stop').at(-1) : undefined;
  const asking = (sid?: string) => { const s = lastStop(sid); return !!s && classify(s) === 'question'; };

  const decisions = input.decisions.filter(d => d.status === 'open').slice(-20).map(({ id, question }) => ({ id, question: clip(question, 120) }));

  const orch = findOrch(snap, feed);
  const orchSid = orch?.agent_session?.value;
  const orchLast = orchSid ? bySid.get(orchSid)?.at(-1) : undefined;
  const mood: OrchMood =
    orch?.agent_status === 'blocked' ? 'blocked'
    : orch?.agent_status === 'working'
      ? orchLast?.event === 'UserPromptSubmit' && now - Date.parse(orchLast.ts) < THINKING_MS ? 'thinking' : 'working'
    : decisions.length || asking(orchSid) ? 'waiting'
    : 'idle';

  const running = input.workers.filter(w => w.status === 'running');
  const paneOf = (w: WorkerRecord) => snap.agents.find(a => a.pane_id === w.pane);
  // Codex panes carry no session id, so their feed events are matched by worktree.
  const sidOf = (w: WorkerRecord) => w.sid || feed.filter(e => e.cwd && e.cwd === w.worktree).at(-1)?.sid;
  const workers = running.slice(-MAX_WORKERS).map((w): WorkerView => {
    const live = paneOf(w)?.agent_status;
    const sid = sidOf(w);
    const status: WorkerStatus =
      live === 'blocked' ? 'blocked'
      : live === 'working' ? 'working'
      : asking(sid) ? 'asking'
      : live === 'idle' ? 'idle'
      : 'done';
    return { name: w.name, repo: w.repo, kind: w.kind ?? 'claude', status, said: lastLine(lastStop(sid)), started: w.started ?? '' };
  });

  const mine = new Set([orch?.pane_id, ...running.map(w => w.pane)]);
  const sessions: Record<string, number> = {};
  for (const a of snap.agents) if (!mine.has(a.pane_id)) sessions[a.agent_status] = (sessions[a.agent_status] ?? 0) + 1;

  return {
    v: 1,
    ts: new Date(now).toISOString(),
    orch: { state: mood, said: lastLine(lastStop(orchSid)) },
    workers,
    decisions,
    sessions,
    actions: lastActions(input.log),
  };
}

// herdr's snapshot, or null when it failed. A failed snapshot must not publish: an empty one would mark every
// worker done and refresh ts, hiding the outage from the pet's stale check.
export function parseSnapshot(text: string): Snapshot | null {
  try {
    const snap = JSON.parse(text)?.result?.snapshot;
    return Array.isArray(snap?.agents) && Array.isArray(snap?.workspaces) ? snap : null;
  } catch { return null; }
}

// Follows the feed's day files, reading only bytes appended since the last call. Keeps the files it is asked for
// (today and yesterday), so a question asked before midnight still counts after it.
export type ReadFrom = (file: string, offset: number) => string;
export function feedReader(readFrom: ReadFrom) {
  const files = new Map<string, { offset: number; rest: string; events: FeedEvent[] }>();
  return (names: string[]): FeedEvent[] => {
    for (const k of files.keys()) if (!names.includes(k)) files.delete(k);
    for (const name of names) {
      const f = files.get(name) ?? files.set(name, { offset: 0, rest: '', events: [] }).get(name)!;
      const chunk = readFrom(name, f.offset);
      f.offset += Buffer.byteLength(chunk);
      const lines = (f.rest + chunk).split('\n');
      f.rest = lines.pop()!;
      for (const l of lines) { try { if (l) f.events.push(JSON.parse(l)); } catch {} }
    }
    return names.flatMap(n => files.get(n)!.events);
  };
}
