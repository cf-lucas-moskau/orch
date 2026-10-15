// orch's hands: run, steer, gates, cleanup, workers, continue, brief, review, judge, restore, and the PR commands.
// Usage: npm run -s orch -- <command> [args]. Every action that changes a session is logged to log.md.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedEvent } from './board.ts';
import { buildBrief, parseDecision, parseLearned } from './brief.ts';
import {
  canDispatch, canSteer, cleanupBlocker, inputDraft, findLive, isTrustDialog, pairNames, parseAutonomy, parseCap, parseProjects, pickWinner, resolveProject,
  restoreList, resumeCommand, trustKeys, workerBrief, workerPrompt, type Autonomous, type Candidate, type Kind, type Live, type Project, type Worker,
} from './dispatch.ts';
import { nextTasks, parsePlan, setTaskState } from './plan.ts';
import { addressTask, mergeBlocker, renderTriage, triagePrs, type Pr, type PrState } from './prs.ts';
import { FINDINGS_SCHEMA, mergeFindings, parseFindings, renderReview, reviewPrompt, type Finding, type Merged } from './review.ts';

const root = process.env.ORCH_DIR ?? join(import.meta.dirname, '..');
const read = (p: string, fallback = '') => { try { return readFileSync(join(root, p), 'utf8'); } catch { return fallback; } };
const die = (msg: string): never => { console.error(msg); process.exit(1); };
const stamp = () => new Date().toLocaleString('sv-SE').slice(0, 16);
const log = (msg: string) => appendFileSync(join(root, 'log.md'), `- ${stamp()} ${msg}\n`);

function herdr(...args: string[]): any {
  const r = spawnSync('herdr', args, { encoding: 'utf8' });
  const out = (r.stdout || r.stderr).trim();
  try { return JSON.parse(out); } catch { return { error: { code: 'unparsed', message: out } }; }
}
const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e: any) { return die(`git ${args.join(' ')} failed in ${cwd}: ${e.stderr ?? e.message}`); }
};

const workersFile = 'workers.json';
const loadWorkers = (): Worker[] => JSON.parse(read(workersFile, '[]'));
const saveWorkers = (ws: Worker[]) => writeFileSync(join(root, workersFile), JSON.stringify(ws, null, 2) + '\n');
const live = (): Live[] => herdr('agent', 'list').result?.agents ?? [];
const projects = () => parseProjects(read('projects.md'));
const gitTop = (path: string) => {
  const r = spawnSync('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
const projectOf = (w: Worker): Project =>
  projects().find(p => p.path === w.repoPath || p.repo === w.repo) ?? { repo: w.repo, path: w.repoPath ?? '', gates: [], notes: '' };
const project = (arg: string) => resolveProject(arg, projects(), gitTop) ?? die(`${arg} is not a registered repo, a git path, or a repo under ORCH_CODE_DIR (default ~/code)`);
// local.md holds the user's own overrides, including the cap.
const cap = () => parseCap(read('local.md') + read('policies.md'));
// poteto-mode needs pstack; without it workers get the plain prompt.
const hasPstack = () => { try { return readFileSync(join(homedir(), '.claude/plugins/installed_plugins.json'), 'utf8').includes('"pstack@'); } catch { return false; } };
const worker = (name: string) => loadWorkers().find(w => w.name === name && w.status === 'running') ?? die(`no running worker ${name}`);

// Submit and confirm the session picked it up, without waiting for the whole turn.
function submit(target: string, text: string) {
  const r = herdr('agent', 'prompt', target, text, '--wait', '--until', 'working', '--until', 'blocked', '--until', 'done', '--timeout', '20000');
  if (r.error) die(`prompt to ${target} failed: ${r.error.code} ${r.error.message}`);
  return r.result.agent.agent_status as string;
}

// herdr reports ready a moment before Claude's input box takes pastes, also after the trust dialog.
function waitReady(name: string) {
  for (let i = 0; i < 60; i++) {
    spawnSync('sleep', ['1']);
    const a = herdr('agent', 'get', name).result?.agent;
    const screen = spawnSync('herdr', ['agent', 'read', name, '--source', 'visible'], { encoding: 'utf8' }).stdout;
    if (a?.agent_status === 'blocked') return { error: { code: 'agent_blocked', message: 'blocked after trust' } };
    if (['idle', 'done'].includes(a?.agent_status) && a.interactive_ready && /❯|›/.test(screen) && !isTrustDialog(screen)) {
      spawnSync('sleep', ['3']);
      return { result: a };
    }
  }
  return { error: { code: 'timeout', message: 'not ready after trust' } };
}

function run([repoArg, name, ...args]: string[]) {
  if (!repoArg || !name) die('usage: orch run <repo> <name> [task] [--kind claude|codex|both] [--from <ref>]');
  const flag = (f: string) => args.includes(f) ? args[args.indexOf(f) + 1] : undefined;
  const k = args.indexOf('--kind');
  const rest = args.filter((a, i) => !['--kind', '--from'].includes(a) && !['--kind', '--from'].includes(args[i - 1]));
  const from = flag('--from');
  const p = project(repoArg);
  const planFile = `plans/${p.repo}.md`;
  const plan = parsePlan(read(planFile));
  const planned = plan.tasks.find(t => t.slug === name);
  const task = rest.join(' ').trim() || (planned?.text ?? die(`no task given and no ${name} task in ${planFile}`));
  const kind = k >= 0 ? args[k + 1] : planned?.kind ?? 'claude';
  if (!['claude', 'codex', 'both'].includes(kind)) die('kind must be claude, codex or both');

  const workers = loadWorkers();
  const names = kind === 'both' ? [pairNames(name).claude, pairNames(name).codex] : [name];
  if (kind === 'both' && name.length > 29) die('pair names add -cl/-cx; keep the name to 29 characters');
  for (let i = 0; i < names.length; i++) {
    const blocker = canDispatch([...workers, ...names.slice(0, i).map(() => ({ status: 'running' }) as Worker)], cap(), names[i], live());
    if (blocker) die(blocker);
  }
  const base = git(p.path, 'rev-parse', from ?? 'HEAD').trim();
  if (kind === 'both') {
    startWorker(p, names[0], 'claude', task, { pair: name, base }, from);
    startWorker(p, names[1], 'codex', task, { pair: name, base }, from);
  } else startWorker(p, name, kind as Kind, task, { base }, from);
  if (planned) writeFileSync(join(root, planFile), setTaskState(read(planFile), name, 'running'));
}

function startWorker(p: Project, name: string, kind: Kind, task: string, extra: { pair?: string; base: string; prHead?: string }, from?: string) {
  const branch = `orch/${name}`;
  const wt = herdr('worktree', 'create', '--cwd', p.path, '--branch', branch, ...(from ? ['--base', from] : []), '--label', name, '--no-focus');
  if (wt.error) die(`worktree create failed: ${wt.error.message}`);
  const pane = wt.result.root_pane.pane_id, workspace = wt.result.workspace.workspace_id, path = wt.result.worktree.path;

  let started = herdr('agent', 'start', name, '--kind', kind, '--pane', pane, '--timeout', '60000');
  const screen = spawnSync('herdr', ['agent', 'read', name, '--source', 'visible'], { encoding: 'utf8' }).stdout;
  // The worktree is a fresh folder orch just created, so its folder trust prompt is answered.
  if (started.error?.code === 'agent_not_ready') for (const key of trustKeys(screen) ?? []) herdr('agent', 'send-keys', name, key);
  if (!started.error || isTrustDialog(screen)) started = waitReady(name);
  const rec: Worker = {
    name, kind, ...extra, repo: p.repo, repoPath: p.path, task, branch, worktree: path, workspace, pane,
    sid: herdr('agent', 'get', name).result?.agent?.agent_session?.value ?? '', started: stamp(), status: 'running',
  };
  saveWorkers([...loadWorkers(), rec]);
  if (started.error) {
    log(`run ${name} on ${p.repo}: started but not ready (${started.error.code}), pane ${pane}. Needs a decision.`);
    die(`worker ${name} is not ready (${started.error.code}); read pane ${pane} and file a decision`);
  }
  const brief = join(root, 'briefs', `${name}.md`);
  mkdirSync(join(root, 'briefs'), { recursive: true });
  writeFileSync(brief, workerBrief(task, p, rec));
  const status = submit(name, workerPrompt(rec, brief, hasPstack()));
  log(`run ${name} (${kind}${extra.pair ? `, pair ${extra.pair}` : ''}) on ${p.repo} (${branch}, pane ${pane}): ${task.slice(0, 120)}`);
  console.log(`${name} (${kind}) ${status} in ${pane}, worktree ${path}`);
}

function steer([target, ...rest]: string[]) {
  const text = rest.join(' ').trim();
  if (!target || !text) die('usage: orch steer <name|pane> <text>');
  const a = findLive(live(), target);
  let draft = '';
  if (a) {
    const r = spawnSync('herdr', ['agent', 'read', a.pane_id, '--source', 'visible', '--ansi'], { encoding: 'utf8' });
    // Can't see the input box: assume someone is typing rather than risk typing over them.
    const d = r.status === 0 && r.stdout?.trim() ? inputDraft(r.stdout) : null;
    draft = d ?? '(no input box visible)';
  }
  const blocker = canSteer(a, draft);
  if (blocker) die(`not sent: ${blocker}`);
  const status = submit(a!.pane_id, text);
  log(`steer ${a!.name ?? a!.pane_id}: ${text.slice(0, 160)}`);
  console.log(`sent to ${a!.name ?? a!.pane_id}, now ${status}`);
}

// Runs the repo's gates in the worker's worktree and, on a pass, makes the worker's one local commit.
function runGates(w: Worker): { passed: boolean; report: string } {
  const p = projectOf(w);
  const lines: string[] = [];
  let failed = 0;
  if (!p.gates.length) lines.push(`no gates registered for ${w.repo}; the worker's own report is all there is`);
  for (const g of p.gates) {
    const r = spawnSync('/bin/bash', ['-lc', g], { cwd: w.worktree, encoding: 'utf8', timeout: 15 * 60_000 });
    const ok = r.status === 0;
    if (!ok) failed++;
    lines.push(`${ok ? 'PASS' : 'FAIL'} ${g}`);
    if (!ok) lines.push((r.stdout + r.stderr).trim().split('\n').slice(-15).join('\n'));
  }
  if (!failed && git(w.worktree, 'status', '--porcelain').trim()) {
    git(w.worktree, 'add', '-A');
    git(w.worktree, 'commit', '-q', '-m', `${w.task.split('\n')[0].slice(0, 72)}\n\nWritten by ${w.kind ?? 'claude'} worker ${w.name}, committed by orch after the gates passed.`);
    lines.push(`committed: ${git(w.worktree, 'log', '--oneline', '-1').trim()}`);
  }
  log(`gates ${w.name}: ${failed ? `${failed} failed` : p.gates.length ? 'all passed' : 'none registered'}`);
  return { passed: !failed, report: lines.join('\n') };
}

function gates([name]: string[]) {
  const r = runGates(worker(name));
  console.log(r.report);
  process.exit(r.passed ? 0 : 1);
}

function cleanup([name, flag]: string[]) {
  const w = worker(name);
  const abandon = flag === '--abandon';
  if (existsSync(w.worktree)) {
    const blocker = cleanupBlocker(
      git(w.worktree, 'status', '--porcelain'),
      git(w.worktree, 'rev-list', '--oneline', w.branch, '--not', `--exclude=${w.branch}`, '--branches', '--remotes'));
    if (blocker && !abandon) die(`not cleaned: ${blocker}\nFile a decision; after the user agrees, rerun with --abandon.`);
  }
  if (findLive(live(), w.pane)) herdr('pane', 'close', w.pane);
  if (existsSync(w.worktree)) {
    const r = herdr('worktree', 'remove', '--workspace', w.workspace, ...(abandon ? ['--force'] : []));
    if (r.error) git(w.worktree, 'worktree', 'remove', ...(abandon ? ['--force'] : []), w.worktree);
  }
  saveWorkers(loadWorkers().map(x => x.name === name && x.status === 'running' ? { ...x, status: 'closed' } : x));
  log(`cleanup ${name}${abandon ? ' (abandoned, the user decided)' : ''}: pane ${w.pane} closed, worktree removed, branch ${w.branch} kept`);
  console.log(`${name} cleaned up; branch ${w.branch} kept`);
}

function workers() {
  const agents = live();
  const ws = loadWorkers().filter(w => w.status === 'running');
  console.log(`${ws.length}/${cap()} workers`);
  for (const w of ws) console.log(`${w.name} [${w.pane}] ${findLive(agents, w.pane)?.agent_status ?? 'gone'} on ${w.repo}: ${w.task.slice(0, 80)}`);
}

function cont([project]: string[]) {
  if (!project) die('usage: orch continue <project>');
  const plan = parsePlan(read(`plans/${project}.md`) || die(`no plans/${project}.md`));
  const ws = loadWorkers();
  const mine = ws.filter(w => w.status === 'running' && w.repo === project);
  console.log(`# ${plan.project}\nGoal: ${plan.goal}\nMilestone: ${plan.milestone}`);
  for (const s of ['running', 'blocked', 'open', 'done'] as const)
    console.log(`${s}: ${plan.tasks.filter(t => t.state === s).map(t => t.slug).join(', ') || '-'}`);
  console.log(`workers on ${project}: ${mine.map(w => w.name).join(', ') || '-'}`);
  console.log(`dispatch next: ${nextTasks(plan, ws, cap()).map(t => t.slug).join(', ') || 'nothing (cap reached or no open tasks)'}`);
}

function restore() {
  const now = Date.now();
  const feed: FeedEvent[] = [2, 1, 0].map(o => new Date(now - o * 864e5).toLocaleDateString('sv-SE'))
    .flatMap(d => read(`feed/${d}.jsonl`).split('\n'))
    .flatMap(l => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  const liveSids = new Set(live().map(a => a.agent_session?.value ?? ''));
  const names: Record<string, { name: string }> = JSON.parse(read('sessions.json', '{}'));
  const lost = restoreList(feed, liveSids, new Date(now - 48 * 36e5).toISOString())
    .filter(l => !l.cwd.includes('/.herdr/worktrees/') || loadWorkers().some(w => w.sid === l.sid && w.status === 'running'));
  if (!lost.length) return console.log('nothing to restore');
  for (const l of lost) console.log(`${names[l.sid]?.name ?? l.sid.slice(0, 8)} (${l.kind}, last ${l.lastTs.slice(0, 16)}): cd ${l.cwd} && ${resumeCommand(l)}${l.asked ? `\n  was asked: ${l.asked.slice(0, 100)}` : ''}`);
}

function brief() {
  const now = Date.now();
  const days = [1, 0].map(o => new Date(now - o * 864e5).toLocaleDateString('sv-SE'));
  const feed: FeedEvent[] = days.flatMap(d => read(`feed/${d}.jsonl`).split('\n'))
    .flatMap(l => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
  const dir = (d: string) => existsSync(join(root, d)) ? readdirSync(join(root, d)).filter(f => f.endsWith('.md')) : [];
  console.log(buildBrief({
    date: days[1], feed, since: new Date(now - 14 * 36e5).toISOString(),
    names: JSON.parse(read('sessions.json', '{}')),
    decisions: dir('decisions').filter(f => /^D-\d+\.md$/.test(f)).map(f => parseDecision(read(`decisions/${f}`))),
    plans: dir('plans').filter(f => f !== 'README.md').map(f => parsePlan(read(`plans/${f}`))),
    learned: dir('learned').flatMap(f => parseLearned(read(`learned/${f}`)).map(l => ({ ...l, id: `${f.replace('.md', '')}/${l.id}` }))),
    workers: loadWorkers(),
  }));
}


// Runs a model headless and resolves with its stdout; never rejects, failures come back as text.
const headless = (cmd: string, args: string[], input: string, cwd: string) => new Promise<{ ok: boolean; out: string }>(res => {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, ORCH_DIR: '/nonexistent' } });
  let out = '', err = '';
  c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
  const t = setTimeout(() => c.kill(), 20 * 60_000);
  c.on('error', e => { clearTimeout(t); res({ ok: false, out: e.message }); });
  c.on('close', code => { clearTimeout(t); res({ ok: code === 0, out: code === 0 ? out : `${out}\n${err}`.trim() }); });
  c.stdin.end(input);
});

// Same diff, same prompt, Claude and Codex in parallel on a throwaway checkout; findings matched across models.
// Generated code is never reviewed; --only narrows a large change to one part.
const NOT_REVIEWED = [':(exclude)**/generated/**', ':(exclude)**/mocks/**', ':(exclude)**/package-lock.json'];

async function bimodel(p: Project, base: string, sha: string, label: string, only: string[] = []): Promise<{ m: Merged; out: string; file: string; diffLines: number }> {
  const mb = git(p.path, 'merge-base', base, sha).trim();
  const diff = git(p.path, 'diff', '--no-color', '--no-ext-diff', `${mb}..${sha}`, '--', ...(only.length ? only : ['.']), ...NOT_REVIEWED);
  if (!diff.trim()) die(`no changes between ${base} and ${label}`);
  if (diff.length > 400_000) die(`diff is ${Math.round(diff.length / 1000)} KB; review it in parts with --base or --only <path>`);
  const diffLines = diff.split('\n').filter(l => /^[+-](?![+-])/.test(l)).length;

  const wt = mkdtempSync(join(tmpdir(), `orch-review-${p.repo}-`));
  git(p.path, 'worktree', 'add', '-q', '--detach', wt, sha);
  const prompt = reviewPrompt({ repo: p.repo, base, head: label, diff });
  const schema = join(wt, '.orch-review-schema.json'), last = join(wt, '.orch-review-codex.txt');
  writeFileSync(schema, JSON.stringify(FINDINGS_SCHEMA));
  const notes: string[] = [];
  try {
    const [c, x] = await Promise.all([
      // After a long tool loop Claude's last message can be empty, so ask for schema-checked output instead of text.
      headless('claude', ['-p', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--no-session-persistence', '--output-format', 'json', '--json-schema', JSON.stringify(FINDINGS_SCHEMA)], prompt, wt)
        .then(r => { try { const j = JSON.parse(r.out); return j.structured_output ? { ok: true, out: JSON.stringify(j.structured_output) } : { ok: false, out: j.result || r.out }; } catch { return r; } }),
      headless('codex', ['exec', '--disable', 'hooks', '-c', 'model_reasoning_effort="high"', '--sandbox', 'read-only', '--ephemeral', '--output-schema', schema, '-o', last, '-C', wt, '-'], prompt, wt)
        .then(r => { try { return r.ok ? { ok: true, out: readFileSync(last, 'utf8') } : r; } catch { return { ok: false, out: 'no last message written' }; } }),
    ]);
    const take = (name: string, r: { ok: boolean; out: string }): Finding[] => {
      const fs = r.ok ? parseFindings(r.out) : null;
      if (!fs) notes.push(`${name} gave no usable findings: ${r.out.replace(/\s+/g, ' ').slice(-300)}`);
      return fs ?? [];
    };
    const m = mergeFindings(take('Claude', c), take('Codex', x));
    const date = new Date().toLocaleDateString('sv-SE');
    const out = renderReview({ repo: p.repo, base, head: label, date, m, notes });
    mkdirSync(join(root, 'reviews'), { recursive: true });
    const file = join('reviews', `${date}-${p.repo}-${label.replace(/[^a-z0-9-]+/gi, '').slice(0, 30) || sha.slice(0, 8)}.md`);
    writeFileSync(join(root, file), out);
    log(`review ${p.repo} ${label}: ${m.both.length} agreed, ${m.claudeOnly.length} Claude only, ${m.codexOnly.length} Codex only -> ${file}`);
    return { m, out, file, diffLines };
  } finally {
    spawnSync('git', ['-C', p.path, 'worktree', 'remove', '--force', wt]);
  }
}

async function review([repoArg, target, ...rest]: string[]) {
  if (!repoArg || !target) die('usage: orch review <repo> <#pr|branch|sha> [--base <ref>] [--only <path>]...');
  const only = rest.flatMap((a, i) => rest[i - 1] === '--only' ? [a] : []);
  const p = project(repoArg);
  let head = target, base = rest.includes('--base') ? rest[rest.indexOf('--base') + 1] ?? '' : '';
  const pr = target.match(/^#?(\d+)$/)?.[1];
  if (pr) {
    const r = spawnSync('gh', ['pr', 'view', pr, '--json', 'headRefOid,baseRefName'], { cwd: p.path, encoding: 'utf8' });
    if (r.status !== 0) die(`gh pr view ${pr} failed: ${r.stderr}`);
    const j = JSON.parse(r.stdout);
    git(p.path, 'fetch', '-q', 'origin', j.baseRefName, `pull/${pr}/head`);
    head = j.headRefOid; base ||= `origin/${j.baseRefName}`;
  }
  base ||= git(p.path, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD').trim() || 'main';
  const part = only.length ? `-${only.join('-').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}` : '';
  const r = await bimodel(p, base, git(p.path, 'rev-parse', head).trim(), `${pr ? `pr${pr}` : /^[0-9a-f]{40}$/.test(head) ? head.slice(0, 8) : head}${part}`, only);
  console.log(r.out);
}

// A pair is done when both workers are: gates on each, a bimodel review of each, and the better one wins.
async function judge([slug]: string[]) {
  if (!slug) die('usage: orch judge <pair>');
  const pair = loadWorkers().filter(w => w.pair === slug && w.status === 'running');
  if (pair.length !== 2) die(`no running pair ${slug}`);
  const agents = live();
  const busy = pair.filter(w => !['idle', 'done'].includes(findLive(agents, w.pane)?.agent_status ?? ''));
  if (busy.length) die(`still working: ${busy.map(w => w.name).join(', ')}`);
  const p = projectOf(pair[0]);
  const cands: Candidate[] = [];
  const sections: string[] = [];
  for (const w of pair) {
    const g = runGates(w);
    const ahead = git(w.worktree, 'rev-list', '--count', `${w.base}..HEAD`).trim() !== '0';
    const r = ahead ? await bimodel(p, w.base!, git(w.worktree, 'rev-parse', 'HEAD').trim(), w.name) : null;
    const review = r?.m ?? { both: [], claudeOnly: [], codexOnly: [] };
    cands.push({ name: w.name, kind: w.kind ?? 'claude', gatesPassed: g.passed && ahead, diffLines: r?.diffLines ?? 0, review });
    sections.push(`## ${w.name} (${w.kind}, branch ${w.branch})\n${ahead ? '' : 'no commits on the branch\n'}${g.report}\n${r ? `review: ${r.file}, ${review.both.length} agreed, ${review.claudeOnly.length + review.codexOnly.length} single-model, ${r.diffLines} changed lines` : ''}`);
  }
  const v = pickWinner(cands);
  const out = `# judge ${slug}\n\nWinner: ${v.winner?.name ?? 'none'}. ${v.reason}.\n\n${sections.join('\n\n')}\n`;
  const file = join('reviews', `${new Date().toLocaleDateString('sv-SE')}-${p.repo}-${slug}-judge.md`);
  mkdirSync(join(root, 'reviews'), { recursive: true });
  writeFileSync(join(root, file), out);
  log(`judge ${slug}: ${v.winner?.name ?? 'no winner'} (${v.reason}) -> ${file}`);
  console.log(out);
}


// The PR routine. `prs` lists; `address` and `review` act. `push`, `open-pr`, `post-review` and `merge` are outward:
// each runs only when `## Autonomy` in local.md or policies.md switches it on, or with `--accepted D-NN` after the user accepted.
function allowed(action: Autonomous, args: string[]): string {
  const i = args.indexOf('--accepted');
  if (i >= 0 && /^D-?\d+$/.test(args[i + 1] ?? '')) return args[i + 1];
  if (parseAutonomy(read('local.md'), read('policies.md')).has(action)) return 'autonomous';
  return die(`${action} needs the user: file a decision and rerun with --accepted D-NN, or switch ${action} on under Autonomy in local.md`);
}

const gh = (cwd: string, ...a: string[]) => {
  const r = spawnSync('gh', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout : die(`gh ${a.slice(0, 2).join(' ')} failed: ${r.stderr.trim()}`);
};

function openPrs(p: Project): { me: string; prs: Pr[] } {
  const [owner, name] = gh(p.path, 'repo', 'view', '--json', 'owner,name', '--jq', '.owner.login + " " + .name').trim().split(' ');
  const query = readFileSync(join(import.meta.dirname, 'prs.graphql'), 'utf8');
  const data = JSON.parse(gh(p.path, 'api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', 'states=OPEN', '-f', `query=${query}`));
  return { me: gh(p.path, 'api', 'user', '--jq', '.login').trim(), prs: data.data.repository.pullRequests.nodes };
}

function prs([repoArg]: string[]) {
  if (!repoArg) die('usage: orch prs <repo>');
  const p = project(repoArg);
  const { me, prs } = openPrs(p);
  const ts = triagePrs(prs, me);
  console.log(renderTriage(p.repo, ts));
  for (const t of ts) {
    if (t.kind === 'address') console.log(`next: orch address ${p.repo} ${t.pr.number}`);
    if (t.kind === 'review') console.log(`next: orch review ${p.repo} ${t.pr.number}`);
    if (t.kind === 'rereview') console.log(`next: orch review ${p.repo} ${t.pr.number} (only what changed since ${t.since.slice(0, 16)}), then approve or comment`);
  }
}

function address([repoArg, n, ...args]: string[]) {
  if (!repoArg || !n) die('usage: orch address <repo> <pr> [--kind codex]');
  const p = project(repoArg);
  const kind = (args.includes('--kind') ? args[args.indexOf('--kind') + 1] : 'claude') as Kind;
  const { me, prs } = openPrs(p);
  const t = triagePrs(prs, me).find(x => x.pr.number === Number(n.replace('#', ''))) ?? die(`#${n} is not an open PR in ${p.repo}`);
  if (t.kind !== 'address') die(`#${t.pr.number} has no colleague feedback to address (${t.kind})`);
  const blocker = canDispatch(loadWorkers(), cap(), `pr${t.pr.number}`, live());
  if (blocker) die(blocker);
  git(p.path, 'fetch', '-q', 'origin', t.pr.headRefName);
  const from = `origin/${t.pr.headRefName}`;
  startWorker(p, `pr${t.pr.number}`, kind, addressTask(t.pr, t.feedback),
    { base: git(p.path, 'rev-parse', from).trim(), prHead: t.pr.headRefName }, from);
}

const OUTWARD = '[--accepted D-NN]';

// --approve approves the PR with the body; without it the body is a comment.
function postReview([repoArg, n, file, ...args]: string[]) {
  if (!repoArg || !n || !file) die(`usage: orch post-review <repo> <pr> <body-file> [--approve] ${OUTWARD}`);
  const approve = args.includes('--approve');
  const by = allowed(approve ? 'approve' : 'comment', args);
  const p = project(repoArg);
  const body = join(root, file);
  if (!existsSync(body)) die(`no ${file}`);
  gh(p.path, 'pr', 'review', n.replace('#', ''), approve ? '--approve' : '--comment', '--body-file', body);
  log(`post-review ${p.repo} #${n} (${by}): ${approve ? 'approved' : 'commented'} with ${file}`);
  console.log(`review ${approve ? 'approved' : 'posted'} on #${n}`);
}

// Never forced: a rejected push comes back as an error for a decision.
function push([name, ...args]: string[]) {
  if (!name) die(`usage: orch push <worker> ${OUTWARD}`);
  const by = allowed('push', args);
  const w = worker(name);
  const target = w.prHead ?? w.branch;
  const r = spawnSync('git', ['-C', w.worktree, 'push', 'origin', `HEAD:${target}`], { encoding: 'utf8' });
  if (r.status !== 0) die(`push failed: ${r.stderr.trim()}`);
  log(`push ${name} (${by}): HEAD -> origin/${target}`);
  console.log(`pushed ${name} to origin/${target}`);
}

// Opens a PR for a pushed worker branch against the branch it started from (the repo default otherwise).
function openPr([name, ...args]: string[]) {
  if (!name) die(`usage: orch open-pr <worker> [--base <branch>] ${OUTWARD}`);
  const by = allowed('push', args);
  const w = worker(name);
  if (w.prHead) die(`${name} works on an existing PR branch (${w.prHead}); push updates it`);
  const p = projectOf(w);
  const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : null;
  const title = w.task.split('\n')[0].slice(0, 70);
  const body = `${w.task.trim()}\n\nOpened by orch: worker ${name} (${w.kind ?? 'claude'}), gates passed.`;
  const url = gh(p.path, 'pr', 'create', '--head', w.branch, '--title', title, '--body', body, ...(base ? ['--base', base] : [])).trim();
  log(`open-pr ${name} (${by}): ${url}`);
  console.log(url);
}

// Squash-merges once nothing blocks it. Never --admin: branch protection always wins.
function merge([repoArg, n, ...args]: string[]) {
  if (!repoArg || !n) die(`usage: orch merge <repo> <pr> ${OUTWARD}`);
  const by = allowed('merge', args);
  const p = project(repoArg);
  const pr = n.replace('#', '');
  const state: PrState = JSON.parse(gh(p.path, 'pr', 'view', pr, '--json', 'isDraft,mergeable,reviewDecision,statusCheckRollup'));
  const blocker = mergeBlocker(state);
  if (blocker) die(`not merged: #${pr} ${blocker}`);
  gh(p.path, 'pr', 'merge', pr, '--squash');
  log(`merge ${p.repo} #${pr} (${by}): squash-merged`);
  console.log(`merged #${pr}`);
}

const [cmd, ...args] = process.argv.slice(2);
const cmds: Record<string, (a: string[]) => void | Promise<void>> = { run, steer, gates, cleanup, workers, continue: cont, brief, review, judge, restore, prs, address, 'post-review': postReview, push, 'open-pr': openPr, merge };
(cmds[cmd] ?? (() => die(`commands: ${Object.keys(cmds).join(', ')}`)))(args);
