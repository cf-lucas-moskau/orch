import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildLimit, building, EMPTY, idleLine, mergedNotCleaned, noteDone, prune, unshipped, unshippedDue, waitingWork } from '../src/capacity.ts';
import { ownerOf } from '../src/lead.ts';
import type { Idea } from '../src/ideas.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const MIN = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00Z');

test('the building limit is the configured one, 3 under 20 GB free, 0 under the Disk floor', () => {
  assert.equal(buildLimit(6, 100, 10), 6);
  assert.equal(buildLimit(4, 20, 10), 4, '20 GB free is not under 20');
  assert.equal(buildLimit(4, 19, 10), 3);
  assert.equal(buildLimit(2, 19, 10), 2, 'the cap never raises a lower limit');
  assert.equal(buildLimit(4, 9, 10), 0);
  assert.equal(buildLimit(4, undefined, 10), 4, 'unknown free space keeps the limit');
});

const idea = (id: string, state: Idea['state'], more: Partial<Idea> = {}) => ({ id, state, ...more }) as Idea;

test('a worker whose idea is parked on an open decision holds no build slot', () => {
  const ideas = [idea('I-1', 'building', { worker: 'idea-1', parked: 'D-01' }), idea('I-2', 'building', { worker: 'idea-2', parked: 'D-02' })];
  assert.deepEqual(building(['idea-1', 'idea-2', 'plan-task'], ideas, new Set(['D-01'])), ['idea-2', 'plan-task'], 'D-02 is no longer open');
});

const OLD_LAYOUT = `# evrloot-next

## Old milestone
- [ ] stale: an old open box

## Now
- [ ] fx: fix it
- [ ] held: a running worker has it
- [~] busy: running
- [x] gone: done
`;
const README_LAYOUT = `# orch
Goal: g
Milestone: m

## Tasks
- [ ] fx: fix it
- [ ] gx: another
- [!] bl: blocked on D-03

## Notes
newest first, no tasks here
`;

test('waiting work is approved ideas with a plan plus open, unheld tasks of the newest section with tasks', () => {
  const ideas = [idea('I-1', 'approved', { plan: 'p' }), idea('I-2', 'approved'), idea('I-3', 'planned', { plan: 'p' }), idea('I-4', 'building', { plan: 'p' })];
  assert.equal(waitingWork(ideas, OLD_LAYOUT, ['held']), 2);
  assert.equal(waitingWork([], README_LAYOUT, []), 2, 'the Tasks section, not the Notes after it');
  assert.equal(waitingWork([], README_LAYOUT, ['gx']), 1);
  assert.equal(waitingWork([], README_LAYOUT.replace('newest first, no tasks here', '- [ ] noted: an idea jotted under Notes'), []), 2, '## Tasks wins over a later section with boxes');
  assert.equal(waitingWork([], '## Tasks\n- [x] a: done\n\n## Later\n- [ ] b: someday\n', []), 0, 'a finished Tasks section waits for nothing');
  assert.equal(waitingWork([], '', []), 0);
  assert.equal(waitingWork([], '- [ ] solo: no sections at all\n', []), 1);
});

test('IDLE comes under the limit with work waiting, at most every 30 minutes per lead', () => {
  let r = idleLine(EMPTY, 'evrloot', 2, 4, 3, T0);
  assert.equal(r.line, 'IDLE lead evrloot: building 2/4, 3 waiting');
  assert.equal(idleLine(r.state, 'evrloot', 2, 4, 3, T0 + 29 * MIN).line, undefined);
  assert.equal(idleLine(r.state, 'other', 0, 4, 1, T0 + MIN).line, 'IDLE lead other: building 0/4, 1 waiting', 'per lead');
  r = idleLine(r.state, 'evrloot', 1, 4, 3, T0 + 30 * MIN);
  assert.equal(r.line, 'IDLE lead evrloot: building 1/4, 3 waiting');
  assert.equal(idleLine(EMPTY, 'evrloot', 4, 4, 3, T0).line, undefined, 'at the limit');
  assert.equal(idleLine(EMPTY, 'evrloot', 3, 3, 3, T0).line, undefined, 'at the 3-cap');
  assert.equal(idleLine(EMPTY, 'evrloot', 0, 4, 0, T0).line, undefined, 'nothing waiting');
});

test('UNSHIPPED comes 45 minutes after DONE, then hourly; a newer DONE or a cleanup resets it', () => {
  let s = noteDone(EMPTY, 'DONE worker idea-7 [w1:p1] abcd1234: all green', T0);
  assert.equal(noteDone(s, 'QUESTION worker idea-7 [w1:p1] -: push?', T0), s, 'only DONE lines start the clock');
  assert.deepEqual(unshippedDue(s, T0 + 44 * MIN), []);
  assert.deepEqual(unshippedDue(s, T0 + 45 * MIN), ['idea-7']);
  const u = unshipped(s, 'idea-7', T0 + 46 * MIN);
  assert.equal(u.line, 'UNSHIPPED worker idea-7: done 46 min ago, not shipped');
  s = u.state;
  assert.deepEqual(unshippedDue(s, T0 + 105 * MIN), []);
  assert.deepEqual(unshippedDue(s, T0 + 106 * MIN), ['idea-7']);
  assert.equal(unshipped(s, 'idea-7', T0 + 106 * MIN).line, 'UNSHIPPED worker idea-7: done 106 min ago, not shipped');
  assert.deepEqual(unshippedDue(noteDone(s, 'DONE worker idea-7 [w1:p1] x: again', T0 + 100 * MIN), T0 + 106 * MIN), []);
  assert.deepEqual(prune(s, new Set(['other'])).done, {});
  assert.deepEqual(Object.keys(prune(s, new Set(['idea-7'])).done), ['idea-7']);
});

test('a merged worker that still runs gets one cleanup reminder, then quiet until its next DONE', () => {
  const s = noteDone(EMPTY, 'DONE worker idea-8 [w1:p1] ab: all green', T0);
  const m = mergedNotCleaned(s, 'idea-8', T0 + 50 * MIN);
  assert.equal(m.line, 'UNSHIPPED worker idea-8: done 50 min ago, merged, not cleaned up');
  assert.deepEqual(unshippedDue(m.state, T0 + 600 * MIN), []);
  assert.deepEqual(unshippedDue(noteDone(m.state, 'DONE worker idea-8 [w1:p1] ab: more', T0 + 600 * MIN), T0 + 645 * MIN), ['idea-8']);
});

test('IDLE goes to the lead it names, UNSHIPPED follows the worker repo', () => {
  const owner = (l: string) => ownerOf(l, n => ({ 'idea-7': 'evrloot-next', 'orch-x': 'orch' } as Record<string, string>)[n]);
  assert.equal(owner('IDLE lead evrloot: building 2/4, 3 waiting'), 'evrloot');
  assert.equal(owner('IDLE lead nobody: building 0/4, 1 waiting'), 'orch');
  assert.equal(owner('UNSHIPPED worker idea-7: done 46 min ago, not shipped'), 'evrloot');
  assert.equal(owner('UNSHIPPED worker idea-7: done 46 min ago, merged, not cleaned up'), 'evrloot');
  assert.equal(owner('UNSHIPPED worker orch-x: done 46 min ago, not shipped'), 'orch');
});

// The watcher end to end, with df, gh and herdr stubbed on PATH. Lead evrloot is not running, so orch prints its lines.
const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

async function until(lines: string[], done: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  return lines;
}

// gh: the stub's body; it gets $head, the HEAD of the one test repo. worktree: idea-7's worktree, the repo by default.
async function watchCapacity(o: { gh?: string; worktree?: (repo: string) => string; want: number }) {
  const root = mkdtempSync(join(tmpdir(), 'orch-capacity-'));
  for (const d of ['feed', 'leads', 'ideas', 'plans', 'bin', 'decisions']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock","repo":"evrloot-next","building":4}');
  const ideaFile = (id: string, state: string, more: object) => writeFileSync(join(root, 'ideas', `${id}.json`), JSON.stringify({ id, thread: 't', message: 'm', author: { id: 'a', name: 'ann' }, text: 'x', state, plan: 'p', created: '2026-11-16T10:00:00Z', updated: '2026-11-16T10:00:00Z', round: 1, dossier: [], ...more }));
  ideaFile('I-1', 'approved', {});
  ideaFile('I-9', 'building', { worker: 'idea-9', parked: 'D-01' });
  writeFileSync(join(root, 'decisions', 'D-01.md'), '# D-01\n- Status: open\n');
  writeFileSync(join(root, 'plans', 'evrloot-next.md'), README_LAYOUT);
  writeFileSync(join(root, 'local.md'), 'Disk floor: 10 GB\nDisk thin: 5 GB\n');
  // idea-8's worktree HEAD is the head of its merged PR; idea-7's branch has none.
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...a: string[]) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  const head = git('rev-parse', 'HEAD');
  const w = (name: string, more = {}) => ({ name, repo: 'evrloot-next', repoPath: root, worktree: repo, branch: `orch/${name}`, pane: `${name}:p1`, sid: name, status: 'running', ...more });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([w('idea-7', { worktree: o.worktree?.(repo) ?? repo }), w('idea-8', { prHead: 'pr/idea-8' }), w('idea-9')]));
  const old = Date.now() - 50 * MIN;
  writeFileSync(join(root, 'capacity.json'), JSON.stringify({ idle: {}, done: { 'idea-7': { at: old }, 'idea-8': { at: old }, gone: { at: old } } }));
  const bin = join(root, 'bin');
  writeFileSync(join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/disk3s5 482797652 1 18874368 87% /System/Volumes/Data"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nhead=${head}\n${o.gh ?? 'case "$*" in *"--head pr/idea-8 "*) echo $head;; esac'}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'herdr'), '#!/bin/sh\necho \'{"result":{"agent":{"agent_status":"idle"}}}\'\n', { mode: 0o755 });
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(SRC, 'watch.ts')],
    { env: { ...process.env, ORCH_DIR: root, ORCH_SID: 'orch0001', ORCH_QUEUE: 'off', ORCH_CAPACITY_CHECK_MS: '200', PATH: `${bin}:${process.env.PATH}` } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => { if (/^(IDLE|UNSHIPPED|CAPACITY)/.test(l)) lines.push(l); });
  await until(lines, () => lines.length >= o.want);
  // A few more checks pass: nothing repeats, nothing late.
  await new Promise(r => setTimeout(r, 1500));
  await new Promise(r => { p.on('exit', r); p.kill(); });
  return { lines: lines.sort(), s: JSON.parse(readFileSync(join(root, 'capacity.json'), 'utf8')) };
}

test('the watcher: IDLE under the 3-cap without the parked worker, UNSHIPPED for an unmerged finish, one reminder for a merged one', async () => {
  const { lines, s } = await watchCapacity({ want: 3 });
  assert.deepEqual(lines, [
    'IDLE lead evrloot: building 2/3, 3 waiting',
    'UNSHIPPED worker idea-7: done 50 min ago, not shipped',
    'UNSHIPPED worker idea-8: done 50 min ago, merged, not cleaned up',
  ]);
  assert.deepEqual(Object.keys(s.done).sort(), ['idea-7', 'idea-8'], 'gone was cleaned up');
  assert.equal(typeof s.done['idea-7'].said, 'number');
  assert.equal(typeof s.done['idea-8'].merged, 'number');
  assert.equal(typeof s.idle.evrloot, 'number');
});

const IDLE_ONLY = ['IDLE lead evrloot: building 2/3, 3 waiting'];

test('a failing gh is unknown: no UNSHIPPED line for anyone', async () => {
  const { lines, s } = await watchCapacity({ gh: 'echo "HTTP 502" >&2\nexit 1', want: 1 });
  assert.deepEqual(lines, IDLE_ONLY);
  assert.equal(s.done['idea-7'].said, undefined);
});

test('a missing worktree is unknown: no UNSHIPPED line for that worker', async () => {
  const { lines } = await watchCapacity({ worktree: repo => join(repo, 'gone'), want: 2 });
  assert.deepEqual(lines, [...IDLE_ONLY, 'UNSHIPPED worker idea-8: done 50 min ago, merged, not cleaned up']);
});

test('a merged PR head git cannot read, even after a fetch, is unknown: no UNSHIPPED line', async () => {
  const { lines } = await watchCapacity({ gh: 'echo 1111111111111111111111111111111111111111', want: 1 });
  assert.deepEqual(lines, IDLE_ONLY);
});
