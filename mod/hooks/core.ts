// Pure: turns orch's ledger (hook feed, sessions.json, workers.json, decisions/, log.md) into what
// orch deck draws. No claude-code imports, so npm test covers it alongside src/.

import type { FeedEvent, SessionInfo, Worker, Decision, Status, Stage, Node, BusKind, BusLine, FlowName, Flow, Deck, Disk, Pressure, Power, DockerRow, Level, Health, HealthRow } from '../types';
export type { FeedEvent, SessionInfo, Worker, Decision, Status, Stage, Node, BusKind, BusLine, FlowName, Flow, Deck, Disk, Pressure, Power, DockerRow, Level, Health, HealthRow } from '../types';

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

export function statusLine(d: Deck, alert: { text: string } | null = null): string {
  const working = d.nodes.filter(n => n.status === 'working').length;
  const needs = d.nodes.filter(n => n.status === 'blocked' || n.status === 'question').length + d.decisions.length;
  const parts = [`${working} working`, needs ? `${needs} need you` : null, d.decisions[0] ? d.decisions.map(x => x.id).join(' ') : null, alert ? `⚠ ${alert.text}` : null];
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

// ---------------------------------------------------------------- machine health
// Parsers for macOS command output, captured samples in test/deck-health.test.ts.

const GB = 1e9;
const DISK_WARN = 30 * GB, DISK_CRIT = 15 * GB;

// `df -k / /System/Volumes/Data`. On APFS both share one container, so one row says it all.
export function parseDf(text: string): Disk[] {
  const disks: Disk[] = [];
  for (const line of text.split('\n').slice(1)) {
    const m = line.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%.*?\s(\/.*)$/);
    if (m) disks.push({ mount: m[4]!, totalB: Number(m[1]) * 1024, freeB: Number(m[3]) * 1024 });
  }
  const shared = disks.length > 1 && disks.every(d => d.totalB === disks[0]!.totalB && d.freeB === disks[0]!.freeB);
  return shared ? [{ ...disks.at(-1)!, mount: disks.map(d => d.mount).join(' + ') }] : disks;
}

// Used the way Activity Monitor counts it: app memory (anonymous minus purgeable) + wired + compressed.
export function parseVmStat(text: string): number {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 16384);
  const n = (k: string) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)\\.`, 'm'))?.[1] ?? 0);
  return (n('Anonymous pages') - n('Pages purgeable') + n('Pages wired down') + n('Pages occupied by compressor')) * page;
}

// `sysctl hw.memsize vm.loadavg kern.boottime hw.ncpu vm.swapusage kern.memorystatus_vm_pressure_level hw.perflevel0.logicalcpu hw.perflevel1.logicalcpu`
export function parseSysctl(text: string) {
  const v = (k: string) => text.match(new RegExp(`^${k.replace(/\./g, '\\.')}: (.*)$`, 'm'))?.[1] ?? '';
  const load = (v('vm.loadavg').match(/[\d.]+/g) ?? []).map(Number);
  const swap = v('vm.swapusage').match(/used = ([\d.]+)M/)?.[1];
  const level = Number(v('kern.memorystatus_vm_pressure_level'));
  return {
    memB: Number(v('hw.memsize')),
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] as [number, number, number],
    cpus: Number(v('hw.ncpu')) || 1,
    pCores: Number(v('hw.perflevel0.logicalcpu')) || null,
    eCores: Number(v('hw.perflevel1.logicalcpu')) || null,
    bootS: Number(v('kern.boottime').match(/sec = (\d+)/)?.[1] ?? 0),
    swapB: swap ? Number(swap) * 1024 * 1024 : 0,
    pressure: (level >= 4 ? 'critical' : level >= 2 ? 'warn' : 'normal') as Pressure,
  };
}

// `pmset -g batt`. A desktop Mac has the first line only.
export function parseBatt(text: string): Power {
  const source = text.match(/drawing from '([^']+)'/)?.[1] ?? 'unknown';
  const b = text.match(/InternalBattery.*\t(\d+)%; ([^;]+);([^\n]*)/);
  if (!b) return { source, pct: null, state: '', remaining: null };
  const rem = b[3]!.match(/(\d+:\d\d) remaining/)?.[1] ?? null;
  return { source, pct: Number(b[1]), state: b[2]!.trim(), remaining: rem && rem !== '0:00' ? rem : null };
}

// `pmset -g therm`: macOS only records lines here once it throttles or warns.
export function parseTherm(text: string): { speedLimit: number | null; warning: number | null } {
  const lim = text.match(/CPU_Speed_Limit\s*=\s*(\d+)/)?.[1];
  const warn = text.match(/thermal warning level[^\d\n]*(\d+)/i)?.[1];
  return { speedLimit: lim ? Number(lim) : null, warning: warn ? Number(warn) : null };
}

// A temperature tool's output ("61.2°C", "CPU: 61.2 °C"); 0 means the tool read nothing.
export function parseCelsius(text: string): number | null {
  const c = Number(text.match(/(-?\d+(?:\.\d+)?)\s*°?\s*C\b/)?.[1] ?? text.trim().match(/^(\d+(?:\.\d+)?)$/)?.[1]);
  return Number.isFinite(c) && c > 0 ? c : null;
}

// Docker's own units: "10.4GB", "880.6kB", "0B".
export function parseSize(s: string): number {
  const m = s.match(/^(-?[\d.e+]+)\s*([kMGTP]?)B/i);
  if (!m) return 0;
  return Number(m[1]) * 1000 ** ' kMGTP'.indexOf(m[2]!.toUpperCase().replace('K', 'k') || ' ');
}

// `docker system df --format '{{json .}}'`, one object per line.
export function parseDockerDf(text: string): DockerRow[] {
  const rows: DockerRow[] = [];
  for (const line of text.split('\n')) {
    try {
      const o = JSON.parse(line);
      // Docker reports negative reclaimable for images shared across tags; treat that as unknown.
      const rec = parseSize(String(o.Reclaimable ?? ''));
      rows.push({ type: String(o.Type), sizeB: parseSize(String(o.Size ?? '')), reclaimB: rec >= 0 ? rec : null });
    } catch { /* not a row */ }
  }
  return rows;
}

export const parseDu = (text: string): number | null => {
  const k = text.match(/^(\d+)\s/)?.[1];
  return k ? Number(k) * 1024 : null;
};

export function bytes(b: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${units[i]}`;
}

export function duration(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const TEMP_WARN = 80, TEMP_CRIT = 95;
const worst = (...ls: Level[]): Level => (ls.includes('crit') ? 'crit' : ls.includes('warn') ? 'warn' : 'ok');

// What the Health tab draws, one row per reading, each with its threshold level.
export function healthRows(h: Health, nowMs: number): HealthRow[] {
  const rows: HealthRow[] = [];
  const f = h.fast;
  if (!f) return [{ label: 'health', value: 'reading…', level: 'ok' }];
  for (const d of f.disks) {
    const level: Level = d.freeB < DISK_CRIT ? 'crit' : d.freeB < DISK_WARN ? 'warn' : 'ok';
    rows.push({ label: 'disk', value: `${bytes(d.freeB)} free of ${bytes(d.totalB)} · ${d.mount}`, level, brief: `disk ${bytes(d.freeB)} free` });
  }
  const s = f.sys;
  const memLevel: Level = s.pressure === 'critical' ? 'crit' : s.pressure === 'warn' ? 'warn' : 'ok';
  rows.push({ label: 'memory', value: `${bytes(f.memUsedB)} used of ${bytes(s.memB)} · pressure ${s.pressure}${s.swapB ? ` · swap ${bytes(s.swapB)}` : ''}`, level: memLevel, brief: `memory pressure ${s.pressure}` });
  const cores = s.pCores && s.eCores ? `${s.cpus} cores (${s.pCores}P+${s.eCores}E)` : `${s.cpus} cores`;
  const perCore = s.load[0] / s.cpus;
  rows.push({ label: 'load', value: `${s.load.map(x => x.toFixed(2)).join(' ')} · ${cores} · ${Math.round(perCore * 100)}% per core`, level: perCore > 1.5 ? 'warn' : 'ok', brief: `load ${s.load[0].toFixed(1)}` });
  const t = f.therm;
  const throttled = t.speedLimit !== null && t.speedLimit < 100;
  const tc = h.slow?.tempC ?? null;
  const tempLevel = worst(tc !== null && tc >= TEMP_CRIT ? 'crit' : tc !== null && tc >= TEMP_WARN ? 'warn' : 'ok', throttled || (t.warning ?? 0) > 0 ? 'warn' : 'ok');
  const tempText = tc !== null ? `${tc.toFixed(1)} °C` : 'not readable without sudo';
  const thermText = [throttled ? `throttled to ${t.speedLimit}%` : null, t.warning ? `thermal warning ${t.warning}` : null].filter(Boolean).join(' · ');
  rows.push({ label: 'temp', value: thermText ? `${tempText} · ${thermText}` : tempText, level: tempLevel, brief: tc !== null ? `${tc.toFixed(0)} °C` : thermText });
  const p = f.power;
  const pwr = p.pct === null ? p.source : `${p.pct}% · ${p.state}${p.remaining ? ` · ${p.remaining} ${p.source === 'AC Power' ? 'to full' : 'left'}` : ''} · ${p.source}`;
  rows.push({ label: 'power', value: pwr, level: p.pct !== null && p.source === 'Battery Power' && p.pct < 15 ? 'warn' : 'ok', brief: `battery ${p.pct}%` });
  rows.push({ label: 'uptime', value: duration(Math.max(0, Math.floor(nowMs / 1000) - s.bootS)), level: 'ok' });
  const sl = h.slow;
  if (!sl) rows.push({ label: 'docker', value: 'reading…', level: 'ok' });
  else if (typeof sl.docker === 'string') rows.push({ label: 'docker', value: sl.docker, level: 'ok' });
  else {
    const total = sl.docker.reduce((a, r) => a + r.sizeB, 0);
    const parts = sl.docker.filter(r => r.sizeB > 0).map(r => `${r.type.replace('Local ', '').toLowerCase()} ${bytes(r.sizeB)}${r.reclaimB ? ` (${bytes(r.reclaimB)} free-able)` : ''}`);
    rows.push({ label: 'docker', value: `${bytes(total)} · ${parts.join(' · ')}`, level: 'ok' });
  }
  rows.push({ label: 'worktrees', value: !sl ? 'reading…' : sl.worktreesB === null ? 'unknown' : `${bytes(sl.worktreesB)} in ~/.herdr/worktrees`, level: 'ok' });
  return rows;
}

// The worst reading as a few words for the map and status line, or null when all is fine.
export function healthAlert(rows: HealthRow[]): { level: Level; text: string } | null {
  const bad = rows.filter(r => r.level !== 'ok');
  if (!bad.length) return null;
  return { level: worst(...bad.map(r => r.level)), text: bad.map(r => r.brief ?? r.label).join(' · ') };
}
