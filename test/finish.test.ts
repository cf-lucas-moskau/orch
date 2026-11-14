import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  for (const e of events) step(m, e, JSON.stringify(e));
  return due(m, T0 + nowMin * 60_000).map(({ e }) => `${e.sid}: ${e.msg}`);
};

test('two events of one session in the same second get different keys', () => {
  const m: Finishes = new Map();
  const stop = ev(0, 't', 'Stop', 'Done.'), perm = ev(0, 't', 'Notification', 'Claude needs your permission to use Bash');
  step(m, stop, JSON.stringify(stop));
  const first = m.get('t')!.key;
  step(m, perm, JSON.stringify(perm));
  assert.notEqual(m.get('t')!.key, first);
});

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
const turnEnds = (ls: string[]) => ls.filter(l => /^(DONE|BLOCKED|QUESTION) /.test(l));
async function until(lines: string[], n: number) {
  for (const end = Date.now() + 15_000; turnEnds(lines).length < n; await pause(100)) if (Date.now() > end) assert.fail(`got ${JSON.stringify(lines)}`);
  await pause(1000);
}

test('the watcher says every finished or blocked worker once, as herdr shows it now', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-finish-'));
  for (const d of ['feed', 'leads', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock"}');
  // herdr agent get <pane> answers with the status in state/<pane>; no file, no answer.
  const stub = mkdtempSync(join(tmpdir(), 'herdr-stub-'));
  mkdirSync(join(stub, 'state'));
  writeFileSync(join(stub, 'herdr'), `#!/bin/sh
f="$(dirname "$0")/state/$3"
if [ "$1 $2" = "agent get" ] && [ -f "$f" ]; then echo "{\\"result\\":{\\"agent\\":{\\"agent_status\\":\\"$(cat "$f")\\"}}}"; else echo '{"error":{"code":"stub"}}'; fi
`, { mode: 0o755 });
  const pane = (name: string, status: string) => writeFileSync(join(stub, 'state', `${name}:p1`), status);
  const worker = (name: string, sid: string) => ({ name, repo: 'netto', sid, pane: `${name}:p1`, worktree: join(root, name), status: 'running', branch: `orch/${name}`, task: 't', workspace: 'w', started: '' });
  writeFileSync(join(root, 'workers.json'), JSON.stringify(['perf-q3', 'quiet', 'steered', 'asks', 'approved', 'cleared', 'twin']
    .map(n => worker(n, `${n.slice(0, 3)}00001`))));
  const feed = join(root, 'feed', `${new Date().toLocaleDateString('sv-SE')}.jsonl`);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
  const add = (ts: string, sid: string, cwd: string, event: string, msg = '') =>
    appendFileSync(feed, JSON.stringify({ ts, sid, event, cwd: join(root, cwd), prompt: '', msg, tail: msg }) + '\n');
  add(ago(60), 'per00001', 'perf-q3', 'UserPromptSubmit');
  add(ago(50), 'qui00001', 'quiet', 'UserPromptSubmit');
  add(ago(50), 'ste00001', 'steered', 'Stop', 'Round 1 done.');
  add(ago(45), 'ste00001', 'steered', 'UserPromptSubmit');

  // The first run ever (no done.json) takes the finishes so far as said.
  const first = watcher(root, stub);
  for (const end = Date.now() + 15_000; !existsSync(join(root, 'done.json')); await pause(100)) if (Date.now() > end) assert.fail('no done.json');
  await pause(1000);
  assert.deepEqual(turnEnds(first.lines), []);
  await kill(first.p);

  // While no watcher runs: perf-q3 finishes; quiet's progress Stop goes 40 minutes quiet while its job still runs;
  // asks waits on a permission prompt; approved's prompt was approved since; cleared, after a /clear, asks a question
  // from a new session id in its worktree.
  add(ago(1), 'per00001', 'perf-q3', 'Stop', 'Q3 is in place and uncommitted.');
  add(ago(40), 'qui00001', 'quiet', 'Stop', 'Still running the e2e.');
  pane('quiet', 'working');
  add(ago(1), 'ask00001', 'asks', 'Notification', 'Claude needs your permission to use Bash');
  pane('asks', 'blocked');
  add(ago(1), 'app00001', 'approved', 'Notification', 'Claude needs your permission to use Bash');
  pane('approved', 'working');
  add(ago(1), 'new00001', 'cleared', 'Stop', 'Both options work. Should I push the branch?');
  const second = watcher(root, stub);
  await until(second.lines, 3);
  assert.deepEqual(turnEnds(second.lines).sort(), [
    'BLOCKED worker asks [asks:p1] ask00001: Claude needs your permission to use Bash',
    'DONE worker perf-q3 [perf-q3:p1] per00001: Q3 is in place and uncommitted.',
    'QUESTION worker cleared [cleared:p1] new00001: Both options work. Should I push the branch?',
  ], 'not quiet: its pane is still working; not approved: its pane is no longer blocked');
  // quiet's job ends: the next minute's check says it.
  pane('quiet', 'idle');
  await until(second.lines, 4);
  assert.deepEqual(turnEnds(second.lines).slice(3), ['DONE worker quiet [quiet:p1] qui00001: quiet 30 min after: Still running the e2e.']);
  // Live lines are not said again by the replay.
  add(new Date().toISOString(), 'ste00001', 'steered', 'Stop', 'Round 2 done, gates green.');
  add(new Date().toISOString(), 'qui00001', 'quiet', 'Notification', 'Claude needs your permission to use Write');
  pane('quiet', 'blocked');
  await until(second.lines, 6);
  assert.deepEqual(turnEnds(second.lines).slice(4), [
    'DONE worker steered [steered:p1] ste00001: Round 2 done, gates green.',
    'BLOCKED worker quiet [quiet:p1] qui00001: Claude needs your permission to use Write',
  ]);
  // twin finishes live, then hits a prompt within the same second while no watcher runs.
  const sec = ago(0);
  add(sec, 'twi00001', 'twin', 'Stop', 'Round 1 done.');
  await until(second.lines, 7);
  await kill(second.p);
  add(sec, 'twi00001', 'twin', 'Notification', 'Claude needs your permission to use Edit');
  pane('twin', 'blocked');
  pane('approved', 'blocked');

  const third = watcher(root, stub);
  await until(third.lines, 1);
  await pause(1500);
  assert.deepEqual(turnEnds(third.lines), ['BLOCKED worker twin [twin:p1] twi00001: Claude needs your permission to use Edit'],
    'a re-arm says nothing it already said or dropped, and a same-second event is its own');
  await kill(third.p);
});
