// orch's hands: run, steer, gates, cleanup, workers, continue, brief, review, judge, restore, the PR commands, routines and ideas.
// Usage: npm run -s orch -- <command> [args]. Every action that changes a session is logged to log.md.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedEvent } from './board.ts';
import { buildBrief, parseDecision, parseLearned } from './brief.ts';
import {
  canDispatch, canSteer, cleanupBlocker, parseDiskFloor, renderConsumers, scratchDir, workerComposeProjects, inputDraft, findLive, isTrustDialog, pairNames, parseAutonomy, parseCap, parseProjects, pickWinner, resolveProject,
  restoreList, resumeCommand, trustKeys, workerBrief, workerPrompt, type Autonomous, type Candidate, type Disk, type Kind, type Live, type Project, type Worker,
} from './dispatch.ts';
import { nextTasks, parsePlan, setTaskState } from './plan.ts';
import { addressTask, mergeBlocker, renderTriage, triagePrs, type Pr, type PrState } from './prs.ts';
import { due, nextRun, orchPane, parseRoutine, parseSchedule, renderRoutine, runName, validRoutineName, type Mode, type Routine, type RoutineState } from './routines.ts';
import { idea as ideaCmd } from './ideas-io.ts';
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

// Free space on the volume orch (and the user's data) lives on; on macOS that is the Data volume, not /.
function disk(): Disk | undefined {
  const r = spawnSync('df', ['-k', root], { encoding: 'utf8' });
  const kb = Number(r.stdout?.trim().split('\n')[1]?.split(/\s+/)[3]);
  return Number.isFinite(kb) ? { freeGb: Math.floor(kb / 1048576), floorGb: parseDiskFloor(read('local.md') + read('policies.md')) } : undefined;
}
const CLAUDE_TMP = `/private/tmp/claude-${process.getuid?.() ?? 501}`;
const sizeKb = (path: string) => Number(spawnSync('du', ['-sk', path], { encoding: 'utf8', timeout: 60_000 }).stdout?.split('\t')[0]) || 0;
// What orch knows takes space: running workers' worktrees, Claude's scratch folders, Docker's disk image.
function topConsumers(): string {
  const paths = [...loadWorkers().filter(w => w.status === 'running').map(w => w.worktree), CLAUDE_TMP,
    join(homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw')].filter(p => existsSync(p));
  return renderConsumers(paths.map(path => ({ path, kb: sizeKb(path) })));
}
function dispatchable(workers: Worker[], name: string) {
  const blocker = canDispatch(workers, cap(), name, live(), disk());
  if (blocker) die(blocker.startsWith('disk floor')
    ? `${blocker}\ntop consumers orch knows about:\n${topConsumers()}\nfree space first: scripts/disk-hygiene.sh --dry-run`
    : blocker);
}
// poteto-mode needs pstack; without it workers get the plain prompt.
const hasPstack = () => { try { return readFileSync(join(homedir(), '.claude/plugins/installed_plugins.json'), 'utf8').includes('"pstack@'); } catch { return false; } };
const worker = (name: string) => loadWorkers().find(w => w.name === name && w.status === 'running') ?? die(`no running worker ${name}`);

// Submit and confirm the session picked it up, without waiting for the whole turn.
// A fresh pane sometimes swallows the first paste as terminal noise (agent_prompt_stalled, three times on 2026-10-27/28):
// clear the input line and send it once more before giving up.
function submit(target: string, text: string) {
  const send = () => herdr('agent', 'prompt', target, text, '--wait', '--until', 'working', '--until', 'blocked', '--until', 'done', '--timeout', '20000');
  let r = send();
  if (r.error?.code === 'agent_prompt_stalled') {
    spawnSync('sleep', ['3']);
    herdr('agent', 'send-keys', target, 'ctrl+u');
    r = send();
  }
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
  // Without --from, start from the remote's default branch: a stale local checkout put two audit workers 395 commits behind (2026-10-27).
  const from = flag('--from') ?? remoteDefault(project(repoArg).path);
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
  for (let i = 0; i < names.length; i++) dispatchable([...workers, ...names.slice(0, i).map(() => ({ status: 'running' }) as Worker)], names[i]);
  const base = git(p.path, 'rev-parse', from ?? 'HEAD').trim();
  if (kind === 'both') {
    startWorker(p, names[0], 'claude', task, { pair: name, base }, from);
    startWorker(p, names[1], 'codex', task, { pair: name, base }, from);
  } else startWorker(p, name, kind as Kind, task, { base }, from);
  if (planned) writeFileSync(join(root, planFile), setTaskState(read(planFile), name, 'running'));
}

function remoteDefault(path: string): string | undefined {
  try {
    git(path, 'fetch', '-q', 'origin');
    const remote = git(path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim();
    if (!remote) return undefined;
    // A local default branch ahead of the remote (unpushed commits, as in kurswert on 2026-10-28) is the newer base.
    const local = remote.replace(/^origin\//, '');
    const ahead = spawnSync('git', ['-C', path, 'merge-base', '--is-ancestor', remote, local]).status === 0;
    return ahead ? local : remote;
  } catch {
    return undefined;
  }
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
function runGates(w: Worker, title?: string): { passed: boolean; report: string } {
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
    git(w.worktree, 'commit', '-q', '-m', `${(title ?? w.task.split('\n')[0]).slice(0, 72)}\n\nWritten by ${w.kind ?? 'claude'} worker ${w.name}, committed by orch after the gates passed.`);
    lines.push(`committed: ${git(w.worktree, 'log', '--oneline', '-1').trim()}`);
  }
  log(`gates ${w.name}: ${failed ? `${failed} failed` : p.gates.length ? 'all passed' : 'none registered'}`);
  return { passed: !failed, report: lines.join('\n') };
}

// gates <worker> [-m "<commit title>"]: reused workers keep their first brief, so name the round.
function gates([name, flag, title]: string[]) {
  const r = runGates(worker(name), flag === '-m' ? title : undefined);
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
  // A worker's local stack and scratch folder die with it. Docker being down is not an error.
  const ls = spawnSync('docker', ['compose', 'ls', '-a', '--format', 'json'], { encoding: 'utf8', timeout: 20_000 });
  let stacks: string[] = [];
  try { stacks = ls.status === 0 ? workerComposeProjects(w, JSON.parse(ls.stdout || '[]')) : []; } catch {}
  const downed = stacks.filter(s => spawnSync('docker', ['compose', '-p', s, 'down', '-v'], { cwd: homedir(), encoding: 'utf8', timeout: 120_000 }).status === 0);
  const scratch = scratchDir(CLAUDE_TMP, w.worktree);
  const hadScratch = existsSync(scratch);
  rmSync(scratch, { recursive: true, force: true });
  saveWorkers(loadWorkers().map(x => x.name === name && x.status === 'running' ? { ...x, status: 'closed' } : x));
  const extra = [downed.length ? `compose ${downed.join(', ')} down -v` : '', hadScratch ? 'scratch folder deleted' : ''].filter(Boolean).join(', ');
  log(`cleanup ${name}${abandon ? ' (abandoned, the user decided)' : ''}: pane ${w.pane} closed, worktree removed${extra ? `, ${extra}` : ''}, branch ${w.branch} kept`);
  console.log(`${name} cleaned up${extra ? ` (${extra})` : ''}; branch ${w.branch} kept`);
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
  // PR numbers are short; an all-digit short commit hash (7+ chars) is a commit, not a PR.
  const pr = target.match(/^#?(\d{1,6})$/)?.[1];
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
  dispatchable(loadWorkers(), `pr${t.pr.number}`);
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

// Routines: routines/<name>.md, due ones started by `tick`, which launchd runs every minute (npm run setup installs it).
const ROUTINE_DIR = join(root, 'routines');
const SCHEDULER = join(homedir(), 'Library', 'LaunchAgents', 'orch.routines.plist');
const DEFAULT_TOOLS = 'Read Grep Glob WebSearch WebFetch';
const loadState = (): Record<string, RoutineState> => JSON.parse(read('routines/state.json', '{}'));
function saveState(name: string, patch: Partial<RoutineState> | null) {
  const all = loadState();
  if (patch) all[name] = { ...all[name], ...patch }; else delete all[name];
  mkdirSync(ROUTINE_DIR, { recursive: true });
  const tmp = join(ROUTINE_DIR, `.state-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  renameSync(tmp, join(ROUTINE_DIR, 'state.json'));
}
const routineNames = () => existsSync(ROUTINE_DIR) ? readdirSync(ROUTINE_DIR).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => f.slice(0, -3)) : [];
const loadRoutine = (name: string) => parseRoutine(read(`routines/${name}.md`), name);
const alive = (pid?: number) => { try { return !!pid && process.kill(pid, 0); } catch { return false; } };
const self = (...a: string[]) => spawnSync(process.execPath, [...process.execArgv, join(import.meta.dirname, 'orch.ts'), ...a], { cwd: root, encoding: 'utf8' });
const when = (d: Date) => d.toLocaleString('sv-SE').slice(0, 16);
const toOrch = (text: string) => {
  const o = orchPane(live(), root);
  if (!o) return { ok: false, msg: 'orch is not running' };
  const r = self('steer', o.pane_id, text.replace(/\s*\n\s*/g, ' '));
  return { ok: r.status === 0, msg: (r.stdout || r.stderr).trim() };
};

// retry: nothing happened and the same slot is tried again next tick (orch busy, cap full).
function execRoutine(r: Routine, slot: Date): { ok: boolean; retry?: boolean; msg: string } {
  if (r.mode === 'orch') {
    const s = toOrch(`Routine ${r.name} (${r.schedule}): ${r.prompt}`);
    return s.ok ? { ok: true, msg: 'handed to orch' } : { ok: false, retry: true, msg: s.msg };
  }
  const p = r.repo ? resolveProject(r.repo, projects(), gitTop) : null;
  if (r.repo && !p) return { ok: false, msg: `${r.repo} is not a registered repo or a repo under the code dir` };
  if (r.mode === 'worker') {
    const name = runName(r, slot);
    const w = self('run', r.repo, name, r.prompt);
    if (w.status === 0) return { ok: true, msg: `worker ${name}: ${w.stdout.trim()}` };
    return { ok: false, retry: /cap reached/.test(w.stderr), msg: w.stderr.trim().split('\n')[0] };
  }
  const c = spawnSync('claude', ['-p', '--output-format', 'text', '--allowedTools', r.tools || DEFAULT_TOOLS], {
    cwd: p?.path ?? root, input: r.prompt, encoding: 'utf8', timeout: 30 * 60_000, env: { ...process.env, ORCH_DIR: '/nonexistent' },
  });
  if (c.status !== 0 || !c.stdout.trim()) return { ok: false, msg: `claude -p failed (${c.status ?? c.signal}): ${(c.stderr || '').trim().slice(0, 200)}` };
  const note = `notes/routines/${when(slot).replace(' ', '-').replace(':', '')}-${r.name}.md`;
  mkdirSync(join(root, 'notes', 'routines'), { recursive: true });
  writeFileSync(join(root, note), `# Routine ${r.name}, ${when(slot)}\n\n${c.stdout.trim()}\n`);
  toOrch(`Routine ${r.name} ran headless; its result is in ${note}. Read it and tell me what matters, briefly.`);
  return { ok: true, msg: `result in ${note}` };
}

function routineExec(name: string, slotIso?: string) {
  const r = loadRoutine(name) ?? die(`no valid routines/${name}.md`);
  const slot = slotIso ? new Date(slotIso) : new Date();
  let res: ReturnType<typeof execRoutine>;
  try { res = execRoutine(r, slot); } catch (e: any) { res = { ok: false, msg: e.message }; }
  const status = res.ok ? 'ok' : res.retry ? 'waiting' : 'failed';
  const was = loadState()[name]?.result ?? '';
  saveState(name, { running: undefined, result: `${when(new Date())} ${status}: ${res.msg}`, ...(res.retry ? {} : { last: slot.toISOString() }) });
  if (!res.retry || !was.includes('waiting')) log(`routine ${name} (${r.mode}, slot ${when(slot)}): ${status}, ${res.msg.slice(0, 160)}`);
  console.log(`${name}: ${status}, ${res.msg}`);
}

function tick() {
  const now = new Date();
  const state = loadState();
  for (const name of routineNames()) {
    const r = loadRoutine(name), s = state[name] ?? {};
    if (!r) {
      if (s.result !== 'invalid file') { saveState(name, { result: 'invalid file' }); log(`routine ${name}: invalid file, not run`); }
      continue;
    }
    if (r.paused || alive(s.running)) continue;
    // A routine written by hand starts counting from the first tick that sees it.
    if (!s.last) { saveState(name, { last: now.toISOString() }); continue; }
    const d = due(parseSchedule(r.schedule)!, new Date(s.last), now);
    if (!d) continue;
    if ('skip' in d) {
      saveState(name, { last: d.skip.toISOString(), result: `${when(now)} skipped the ${when(d.skip)} run: missed by more than 12h` });
      log(`routine ${name}: skipped the ${when(d.skip)} run, missed by more than 12h (asleep or off)`);
      continue;
    }
    const c = spawn(process.execPath, [...process.execArgv, join(import.meta.dirname, 'orch.ts'), 'routine', 'exec', name, d.run.toISOString()],
      { cwd: root, detached: true, stdio: 'ignore' });
    c.unref();
    saveState(name, { running: c.pid });
  }
}

function routine([sub, name, ...args]: string[]) {
  const usage = 'usage: orch routine add <name> --at "<schedule>" [--mode orch|worker|headless] [--repo <repo>] [--tools "<tools>"] <prompt>\n'
    + '       orch routine list | run <name> | pause <name> | resume <name> | rm <name>';
  if (sub === 'list' || !sub) {
    const state = loadState();
    const names = routineNames();
    if (!names.length) return console.log('no routines');
    for (const n of names) {
      const r = loadRoutine(n), s = state[n] ?? {};
      if (!r) { console.log(`${n}: invalid file`); continue; }
      const next = r.paused ? 'paused' : `next ${when(nextRun(parseSchedule(r.schedule)!, new Date(s.last ?? Date.now()), new Date()))}`;
      console.log(`${n} [${r.schedule}, ${r.mode}${r.repo ? ` on ${r.repo}` : ''}] ${next}; last: ${s.result ?? 'never ran'}`);
    }
    if (process.platform === 'darwin' && !existsSync(SCHEDULER)) console.log('scheduler not installed: run npm run setup');
    return;
  }
  if (!name) die(usage);
  if (sub === 'exec') return routineExec(name, args[0]);
  if (sub === 'add') {
    const flag = (f: string) => args.includes(f) ? args[args.indexOf(f) + 1] : '';
    const flags = ['--at', '--mode', '--repo', '--tools'];
    const prompt = args.filter((a, i) => !flags.includes(a) && !flags.includes(args[i - 1])).join(' ').trim();
    if (!validRoutineName(name)) die('name must match [a-z][a-z0-9_-]{0,21}');
    if (existsSync(join(ROUTINE_DIR, `${name}.md`))) die(`routines/${name}.md exists; edit it or rm it first`);
    if (!parseSchedule(flag('--at'))) die('schedule examples: "weekdays 08:30", "mon,thu 09:00,14:00", "daily 23:00", "every 2h", "every 30m"');
    const repo = flag('--repo');
    if (repo) project(repo);
    const r = parseRoutine(renderRoutine({ name, schedule: flag('--at'), mode: (flag('--mode') || (repo ? 'worker' : 'orch')) as Mode, repo, tools: flag('--tools'), paused: false, prompt }), name)
      ?? die(`${usage}\nworker mode needs --repo; the prompt must not be empty`);
    mkdirSync(ROUTINE_DIR, { recursive: true });
    writeFileSync(join(ROUTINE_DIR, `${name}.md`), renderRoutine(r));
    const now = new Date();
    saveState(name, { last: now.toISOString(), result: undefined, running: undefined });
    log(`routine add ${name} [${r.schedule}, ${r.mode}${r.repo ? ` on ${r.repo}` : ''}]: ${r.prompt.slice(0, 120)}`);
    console.log(`added ${name}, next run ${when(nextRun(parseSchedule(r.schedule)!, now, now))}`);
    if (process.platform === 'darwin' && !existsSync(SCHEDULER)) console.log('the scheduler is not installed yet: run npm run setup');
    return;
  }
  const r = loadRoutine(name) ?? die(`no valid routines/${name}.md`);
  if (sub === 'run') return routineExec(name);
  if (sub === 'pause' || sub === 'resume') {
    writeFileSync(join(ROUTINE_DIR, `${name}.md`), renderRoutine({ ...r, paused: sub === 'pause' }));
    // Resuming starts from now, so paused slots are not made up.
    if (sub === 'resume') saveState(name, { last: new Date().toISOString() });
    log(`routine ${sub} ${name}`);
    return console.log(`${name} ${sub === 'pause' ? 'paused' : 'resumed'}`);
  }
  if (sub === 'rm') {
    rmSync(join(ROUTINE_DIR, `${name}.md`));
    saveState(name, null);
    log(`routine rm ${name}`);
    return console.log(`${name} removed`);
  }
  die(usage);
}

// The Discord idea bridge; `start` dispatches through run() like any other worker.
async function idea(args: string[]) {
  try { console.log(await ideaCmd(args, { root, log, run })); } catch (e: any) { die(e.message); }
}

const [cmd, ...args] = process.argv.slice(2);
const cmds: Record<string, (a: string[]) => void | Promise<void>> = { run, steer, gates, cleanup, workers, continue: cont, brief, review, judge, restore, prs, address, 'post-review': postReview, push, 'open-pr': openPr, merge, routine, tick, idea };
(cmds[cmd] ?? (() => die(`commands: ${Object.keys(cmds).join(', ')}`)))(args);
