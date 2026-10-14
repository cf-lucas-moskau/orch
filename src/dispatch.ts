import type { Merged } from './review.ts';
// Pure rules for step 3: registry, worker records, and the checks orch runs before it touches a session.

export type Project = { repo: string; path: string; gates: string[]; notes: string };
export type Kind = 'claude' | 'codex';
export type Worker = {
  name: string; kind?: Kind; pair?: string; base?: string; prHead?: string; repo: string; repoPath?: string; task: string; branch: string; worktree: string;
  workspace: string; pane: string; sid: string; started: string; status: 'running' | 'closed';
};
export type Live = { agent_status: string; focused?: boolean; pane_id: string; name?: string; agent_session?: { value?: string } };

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
const codeSpans = (s: string) => [...s.matchAll(/`([^`]+)`/g)].map(m => m[1]);

// Columns are found by header name, so the table can grow.
export function parseProjects(md: string): Project[] {
  const rows = md.split('\n').filter(l => l.trim().startsWith('|') && !/^\|\s*-/.test(l.trim())).map(cells);
  const head = rows.findIndex(r => r[0] === 'Repo');
  if (head < 0) return [];
  const col = (r: string[], name: string) => r[rows[head].indexOf(name)] ?? '';
  return rows.slice(head + 1).filter(r => r[0]).map(r => ({
    repo: r[0], path: expand(col(r, 'Path').replace(/`/g, '')), gates: codeSpans(col(r, 'Gates')), notes: col(r, 'Notes'),
  }));
}

const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

// Any git repo works: a registered name (with its gates), a path, or a folder name under ORCH_CODE_DIR (default ~/code).
// gitTop returns the repo root for a path, or null.
export function resolveProject(arg: string, registry: Project[], gitTop: (path: string) => string | null): Project | null {
  const known = registry.find(p => p.repo === arg);
  if (known) return known;
  for (const cand of [expand(arg), `${expand(process.env.ORCH_CODE_DIR ?? '~/code')}/${arg}`]) {
    const top = gitTop(cand);
    if (top) return registry.find(p => p.path === top) ?? { repo: top.split('/').at(-1)!, path: top, gates: [], notes: '' };
  }
  return null;
}

// A pair is the same task given to Claude and Codex; the better result wins.
export const pairNames = (slug: string) => ({ claude: `${slug}-cl`, codex: `${slug}-cx` });

export type Candidate = { name: string; kind: Kind; gatesPassed: boolean; diffLines: number; review: Merged };
const WEIGHT = { blocking: [10, 4], medium: [3, 1], minor: [0, 0] } as const;

// Lower is better: agreed findings weigh more than single-model ones, blocking more than medium.
export function score(m: Merged): number {
  let s = 0;
  const order = ['blocking', 'medium', 'minor'] as const;
  for (const { claude, codex } of m.both) s += WEIGHT[order[Math.min(order.indexOf(claude.severity), order.indexOf(codex.severity))]][0];
  for (const f of [...m.claudeOnly, ...m.codexOnly]) s += WEIGHT[f.severity][1];
  return s;
}

export function pickWinner(cs: Candidate[]): { winner: Candidate | null; reason: string } {
  const passing = cs.filter(c => c.gatesPassed);
  if (!passing.length) return { winner: null, reason: 'no candidate passed its gates' };
  if (passing.length === 1) return { winner: passing[0], reason: `only ${passing[0].name} passed its gates` };
  const ranked = [...passing].sort((a, b) => score(a.review) - score(b.review) || a.diffLines - b.diffLines);
  const [a, b] = ranked;
  return score(a.review) === score(b.review)
    ? { winner: a, reason: `same review score (${score(a.review)}); ${a.name} has the smaller diff (${a.diffLines} vs ${b.diffLines} lines)` }
    : { winner: a, reason: `review score ${score(a.review)} vs ${score(b.review)} for ${b.name} (lower is better)` };
}

export function parseCap(policies: string): number {
  const m = policies.match(/concurrency cap[^\d]*(\d+)/i);
  return m ? Number(m[1]) : 4;
}

export const validName = (n: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(n);

export function canDispatch(workers: Worker[], cap: number, name: string, live: Live[]): string | null {
  if (!validName(name)) return `name must match [a-z][a-z0-9_-]{0,31}`;
  if (live.some(a => a.name === name)) return `a live agent is already named ${name}`;
  const running = workers.filter(w => w.status === 'running').length;
  return running >= cap ? `concurrency cap reached (${running}/${cap})` : null;
}

// Never type into a pane the user is using, never answer an approval dialog for them.
export function canSteer(a: Live | undefined): string | null {
  if (!a) return 'no live agent with that name or pane';
  if (a.focused) return 'the user is in that pane (focused)';
  if (a.agent_status === 'blocked') return 'session is blocked on a dialog; that is a decision, not a prompt';
  return null;
}

// Folder trust prompts and the keys that accept them: Claude defaults to "No, exit", Codex to "Trust and continue".
export function trustKeys(screen: string): string[] | null {
  if (/Is this a project you created or one you trust/.test(screen)) return ['down', 'enter'];
  if (/Trust this folder\?[\s\S]*Trust and continue/.test(screen)) return ['enter'];
  return null;
}
export const isTrustDialog = (screen: string) => trustKeys(screen) !== null;

// Worktree removal needs a clean checkout and nothing unpushed, otherwise it is the user's call.
export function cleanupBlocker(porcelain: string, unpushed: string): string | null {
  if (porcelain.trim()) return `uncommitted changes:\n${porcelain.trim()}`;
  if (unpushed.trim()) return `commits on no other branch or remote:\n${unpushed.trim()}`;
  return null;
}

// Claude workers do serious work, so with pstack installed they start in poteto-mode. It cannot be invoked by a model,
// only typed, which is what orch's prompt is. Codex has no pstack.
export const SERIOUS = '/pstack:poteto-mode';

export function workerBrief(task: string, p: Project, w: Pick<Worker, 'name' | 'branch'>): string {
  const gates = p.gates.length ? p.gates.map(g => `\`${g}\``).join(', ') : 'none registered; run the repo\'s own tests';
  return [
    `# Brief for worker ${w.name}`, '',
    `You are worker ${w.name}, dispatched by orch on branch ${w.branch} in an isolated worktree of ${p.repo}.`, '',
    '## Task', '', task.trim(), '',
    '## Rules', '',
    `Gates, all must pass before you report done: ${gates}.`,
    // Workers never commit (Codex's sandbox cannot anyway). orch commits after the gates pass.
    `Commit rule: leave your changes uncommitted; orch runs the gates and commits them on this branch. Never push, merge, open PRs, reply on GitHub, deploy or touch databases; stop and ask instead. These rules override any playbook step that commits, pushes or opens a PR.`,
    `When finished, end with a short report: what changed, gate results, anything you need from the user as a direct question.`, '',
  ].join('\n');
}

// One line on purpose: a pasted newline turns the message into pasted text and the slash command never runs.
export const workerPrompt = (w: Pick<Worker, 'name' | 'kind'>, briefPath: string, pstack = true) =>
  `${w.kind === 'codex' || !pstack ? '' : `${SERIOUS} `}You are worker ${w.name}, dispatched by orch. Read your brief at ${briefPath} and follow it.`;

export function findLive(live: Live[], target: string): Live | undefined {
  return live.find(a => a.name === target || a.pane_id === target);
}

// Sessions killed by a reboot or crash never log SessionEnd. Recent ones that are no longer live are what to resume.
export type Lost = { sid: string; cwd: string; kind: string; lastTs: string; asked: string };
export function restoreList(feed: import('./board.ts').FeedEvent[], liveSids: Set<string>, sinceTs: string): Lost[] {
  const last = new Map<string, import('./board.ts').FeedEvent>();
  const asked = new Map<string, string>();
  for (const e of [...feed].sort((a, b) => a.ts.localeCompare(b.ts))) {
    last.set(e.sid, e);
    if (e.event === 'UserPromptSubmit' && e.prompt) asked.set(e.sid, e.prompt);
  }
  return [...last.values()]
    .filter(e => e.event !== 'SessionEnd' && e.ts >= sinceTs && !liveSids.has(e.sid) && e.cwd)
    .map(e => ({ sid: e.sid, cwd: e.cwd, kind: e.agent ?? 'claude', lastTs: e.ts, asked: asked.get(e.sid) ?? '' }));
}

export const resumeCommand = (l: Lost) => l.kind === 'codex' ? `codex resume ${l.sid}` : `claude --resume ${l.sid}`;
