import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildLimit, EMPTY, idleLine, noteDone, prune, shipped, unshipped, unshippedDue, waitingWork } from '../src/capacity.ts';
import { ownerOf } from '../src/lead.ts';
import type { Idea } from '../src/ideas.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const MIN = 60_000;
const T0 = Date.parse('2026-11-16T12:00:00Z');

test('the building limit is the configured one, 4 when unset, 3 under 20 GB free, 0 under the Disk floor', () => {
  assert.equal(buildLimit(6, 100, 10), 6);
  assert.equal(buildLimit(undefined, 100, 10), 4);
  assert.equal(buildLimit(4, 20, 10), 4, '20 GB free is not under 20');
  assert.equal(buildLimit(4, 19, 10), 3);
  assert.equal(buildLimit(2, 19, 10), 2, 'the cap never raises a lower limit');
  assert.equal(buildLimit(4, 9, 10), 0);
  assert.equal(buildLimit(4, undefined, 10), 4, 'unknown free space keeps the limit');
});

const idea = (id: string, state: Idea['state'], plan?: string) => ({ id, state, plan }) as Idea;
const PLAN = `# evrloot-next

## Old milestone
- [ ] stale: an old open box

## Now
- [ ] fx: fix it
- [ ] held: a running worker has it
- [~] busy: running
- [x] gone: done
`;

test('waiting work is approved ideas with a plan plus open, unheld tasks of the newest plan section', () => {
  const ideas = [idea('I-1', 'approved', 'p'), idea('I-2', 'approved'), idea('I-3', 'planned', 'p'), idea('I-4', 'building', 'p')];
  assert.equal(waitingWork(ideas, PLAN, ['held']), 2);
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

test('UNSHIPPED comes 45 minutes after DONE, then hourly; a newer DONE, a merge or a cleanup resets it', () => {
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
  assert.deepEqual(shipped(s, 'idea-7').done, {});
  assert.deepEqual(prune(s, new Set(['other'])).done, {});
  assert.deepEqual(Object.keys(prune(s, new Set(['idea-7'])).done), ['idea-7']);
});

test('IDLE goes to the lead it names, UNSHIPPED follows the worker repo', () => {
  const owner = (l: string) => ownerOf(l, n => ({ 'idea-7': 'evrloot-next', 'orch-x': 'orch' } as Record<string, string>)[n]);
  assert.equal(owner('IDLE lead evrloot: building 2/4, 3 waiting'), 'evrloot');
  assert.equal(owner('IDLE lead nobody: building 0/4, 1 waiting'), 'orch');
  assert.equal(owner('UNSHIPPED worker idea-7: done 46 min ago, not shipped'), 'evrloot');
  assert.equal(owner('UNSHIPPED worker orch-x: done 46 min ago, not shipped'), 'orch');
});

// The watcher end to end, with df, gh and herdr stubbed on PATH. Lead evrloot is not running, so orch prints its lines.
const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

test('the watcher says IDLE under the 3-cap at 18 GB and UNSHIPPED for an old unmerged finish, and forgets a merged one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-capacity-'));
  for (const d of ['feed', 'leads', 'ideas', 'plans', 'bin']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock","repo":"evrloot-next","building":4}');
  writeFileSync(join(root, 'ideas', 'I-1.json'), JSON.stringify({ id: 'I-1', thread: 't', message: 'm', author: { id: 'a', name: 'ann' }, text: 'x', state: 'approved', plan: 'p', created: '2026-11-16T10:00:00Z', updated: '2026-11-16T10:00:00Z', round: 1, dossier: [] }));
  writeFileSync(join(root, 'plans', 'evrloot-next.md'), '# evrloot-next\n\n## Now\n- [ ] fx: fix it\n');
  writeFileSync(join(root, 'local.md'), 'Disk floor: 10 GB\nDisk thin: 5 GB\n');
  const w = (name: string) => ({ name, repo: 'evrloot-next', repoPath: root, branch: `orch/${name}`, pane: `${name}:p1`, sid: name, status: 'running' });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([w('idea-7'), w('idea-8')]));
  const old = Date.now() - 50 * MIN;
  writeFileSync(join(root, 'capacity.json'), JSON.stringify({ idle: {}, done: { 'idea-7': { at: old }, 'idea-8': { at: old }, gone: { at: old } } }));
  const bin = join(root, 'bin');
  writeFileSync(join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/disk3s5 482797652 1 18874368 87% /System/Volumes/Data"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *orch/idea-8*) echo \'[{"number":3}]\';; *) echo \'[]\';; esac\n', { mode: 0o755 });
  writeFileSync(join(bin, 'herdr'), '#!/bin/sh\necho \'{"result":{"agent":{"agent_status":"idle"}}}\'\n', { mode: 0o755 });
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(SRC, 'watch.ts')],
    { env: { ...process.env, ORCH_DIR: root, ORCH_SID: 'orch0001', ORCH_QUEUE: 'off', ORCH_CAPACITY_CHECK_MS: '200', PATH: `${bin}:${process.env.PATH}` } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => lines.push(l));
  await new Promise(r => setTimeout(r, 3000));
  await new Promise(r => { p.on('exit', r); p.kill(); });
  assert.deepEqual(lines.filter(l => /^(IDLE|UNSHIPPED|CAPACITY)/.test(l)), [
    'IDLE lead evrloot: building 2/3, 2 waiting',
    'UNSHIPPED worker idea-7: done 50 min ago, not shipped',
  ]);
  const s = JSON.parse(readFileSync(join(root, 'capacity.json'), 'utf8'));
  assert.deepEqual(Object.keys(s.done), ['idea-7'], 'idea-8 merged, gone was cleaned up');
  assert.equal(typeof s.done['idea-7'].said, 'number');
  assert.equal(typeof s.idle.evrloot, 'number');
});
