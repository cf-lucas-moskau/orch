import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FeedEvent } from '../src/board.ts';
import { due, step, type Finishes } from '../src/finish.ts';

const T0 = Date.parse('2026-11-14T17:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, sid: string, event: string, msg = ''): FeedEvent => ({ ts: at(min), sid, event, cwd: `/w/${sid}`, prompt: '', msg, tail: msg });

const owed = (events: FeedEvent[], nowMin: number) => {
  const m: Finishes = new Map();
  for (const e of events) step(m, e);
  return due(m, T0 + nowMin * 60_000).map(e => `${e.sid}: ${e.msg}`);
};

test('a session whose last Stop got no prompt after it is owed its finish', () => {
  assert.deepEqual(owed([ev(0, 'q3', 'UserPromptSubmit'), ev(46, 'q3', 'Stop', 'Q3 is in place.'), ev(47, 'q3', 'Notification', 'Claude is waiting for your input')], 48),
    ['q3: Q3 is in place.']);
  assert.deepEqual(owed([ev(0, 'a', 'Stop', 'Done.'), ev(5, 'a', 'UserPromptSubmit')], 60), [], 'answered by a prompt');
  assert.deepEqual(owed([ev(0, 'a', 'Stop', 'Done.'), ev(5, 'a', 'SessionEnd')], 60), [], 'closed');
  assert.deepEqual(owed([ev(0, 'a', 'Stop', 'First.'), ev(5, 'a', 'Stop', 'Second.')], 60), ['a: Second.'], 'only the last Stop');
});

test('a permission prompt with nothing after it is owed its BLOCKED; an idle ping is not, and approval moves on', () => {
  const perm = 'Claude needs your permission to use Bash';
  assert.deepEqual(owed([ev(0, 'p', 'UserPromptSubmit'), ev(3, 'p', 'Notification', perm), ev(4, 'p', 'Notification', 'Claude is waiting for your input')], 5),
    [`p: ${perm}`]);
  assert.deepEqual(owed([ev(0, 'p', 'UserPromptSubmit'), ev(3, 'p', 'Notification', perm), ev(9, 'p', 'Stop', 'Done.')], 10), ['p: Done.']);
  assert.deepEqual(owed([ev(0, 'p', 'Notification', perm), ev(2, 'p', 'UserPromptSubmit')], 10), []);
  assert.deepEqual(owed([ev(0, 'i', 'UserPromptSubmit'), ev(2, 'i', 'Notification', 'Claude is waiting for your input')], 60), []);
});

test('a Stop read as progress is owed only after 30 quiet minutes', () => {
  const feed = [ev(0, 'b', 'UserPromptSubmit'), ev(10, 'b', 'Stop', 'Still running the e2e.')];
  assert.deepEqual(owed(feed, 39), []);
  assert.deepEqual(owed(feed, 40), ['b: Still running the e2e.']);
  assert.deepEqual(owed([...feed, ev(20, 'b', 'Stop', 'E2E green, committed.')], 21), ['b: E2E green, committed.'], 'its wake-up Stop at once');
});

const SRC = join(import.meta.dirname, '..', 'src');
const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

function watcher(root: string, stub: string) {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(SRC, 'watch.ts')],
    { env: { ...process.env, ORCH_DIR: root, ORCH_SID: 'orch0001', ORCH_QUEUE: 'off', ORCH_STALL_CHECK_MS: '300', PATH: `${stub}:${process.env.PATH}` } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => lines.push(l));
  return { p, lines };
}
const kill = (p: ChildProcess) => new Promise(r => { p.on('exit', r); p.kill(); });
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
const done = (ls: string[]) => ls.filter(l => l.startsWith('DONE'));
const turnEnds = (ls: string[]) => ls.filter(l => /^(DONE|BLOCKED) /.test(l));

test('the watcher says every finished worker once: missed between watchers, quiet after progress, and live', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-finish-'));
  for (const d of ['feed', 'leads', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock"}');
  const stub = mkdtempSync(join(tmpdir(), 'herdr-stub-'));
  writeFileSync(join(stub, 'herdr'), '#!/bin/sh\necho \'{"error":{"code":"stub"}}\'\n', { mode: 0o755 });
  const worker = (name: string, sid: string) => ({ name, repo: 'netto', sid, pane: `${name}:p1`, worktree: join(root, name), status: 'running', branch: `orch/${name}`, task: 't', workspace: 'w', started: '' });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([worker('perf-q3', 'q3000001'), worker('busy', 'bus00001'), worker('quiet', 'qui00001'), worker('steered', 'ste00001'), worker('asks', 'ask00001')]));
  const feed = join(root, 'feed', `${new Date().toLocaleDateString('sv-SE')}.jsonl`);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const add = (ts: string, sid: string, cwd: string, event: string, msg = '') =>
    appendFileSync(feed, JSON.stringify({ ts, sid, event, cwd: join(root, cwd), prompt: '', msg, tail: msg }) + '\n');
  add(ago(60), 'q3000001', 'perf-q3', 'UserPromptSubmit');
  add(ago(50), 'bus00001', 'busy', 'UserPromptSubmit');
  add(ago(5), 'bus00001', 'busy', 'Stop', 'Still running the e2e.');
  add(ago(50), 'qui00001', 'quiet', 'UserPromptSubmit');
  add(ago(50), 'ste00001', 'steered', 'Stop', 'Round 1 done.');
  add(ago(45), 'ste00001', 'steered', 'UserPromptSubmit');

  // The first run ever (no done.json) takes the finishes so far as said.
  const first = watcher(root, stub);
  for (const end = Date.now() + 15_000; !existsSync(join(root, 'done.json')); await pause(100)) if (Date.now() > end) assert.fail('no done.json');
  await pause(1000);
  assert.deepEqual(done(first.lines), []);
  await kill(first.p);

  // perf-q3 finishes while no watcher runs (between an expiry and the re-arm).
  add(ago(1), 'q3000001', 'perf-q3', 'Stop', 'Q3 is in place and uncommitted.');
  // quiet's progress Stop has had 30 minutes with nothing after it.
  add(ago(40), 'qui00001', 'quiet', 'Stop', 'Still running the e2e.');
  // asks hits a permission prompt in the same gap.
  add(ago(3), 'ask00001', 'asks', 'UserPromptSubmit');
  add(ago(1), 'ask00001', 'asks', 'Notification', 'Claude needs your permission to use Bash');
  const second = watcher(root, stub);
  for (const end = Date.now() + 15_000; turnEnds(second.lines).length < 3; await pause(100)) if (Date.now() > end) assert.fail(`got ${JSON.stringify(second.lines)}`);
  await pause(1000);
  assert.deepEqual(turnEnds(second.lines).sort(), [
    'BLOCKED worker asks [asks:p1] ask00001: Claude needs your permission to use Bash',
    'DONE worker perf-q3 [perf-q3:p1] q3000001: Q3 is in place and uncommitted.',
    'DONE worker quiet [quiet:p1] qui00001: quiet 30 min after: Still running the e2e.',
  ]);
  // Live: a finish the tail says is not said again by the replay.
  add(new Date().toISOString(), 'ste00001', 'steered', 'Stop', 'Round 2 done, gates green.');
  for (const end = Date.now() + 15_000; done(second.lines).length < 3; await pause(100)) if (Date.now() > end) assert.fail(`got ${JSON.stringify(second.lines)}`);
  await pause(1000);
  assert.equal(done(second.lines).length, 3);
  assert.equal(done(second.lines)[2], 'DONE worker steered [steered:p1] ste00001: Round 2 done, gates green.');
  add(new Date().toISOString(), 'qui00001', 'quiet', 'Notification', 'Claude needs your permission to use Write');
  for (const end = Date.now() + 15_000; turnEnds(second.lines).length < 5; await pause(100)) if (Date.now() > end) assert.fail(`got ${JSON.stringify(second.lines)}`);
  await pause(1000);
  assert.deepEqual(turnEnds(second.lines).slice(4), ['BLOCKED worker quiet [quiet:p1] qui00001: Claude needs your permission to use Write'],
    'a live BLOCKED is said once, not again by the replay');
  await kill(second.p);

  const third = watcher(root, stub);
  await pause(2500);
  assert.deepEqual(turnEnds(third.lines), [], 'a re-arm says nothing it already said');
  await kill(third.p);
  assert.equal(Object.keys(JSON.parse(readFileSync(join(root, 'done.json'), 'utf8'))).length, 5);
});
