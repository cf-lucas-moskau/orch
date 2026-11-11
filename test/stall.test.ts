import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FeedEvent } from '../src/board.ts';
import { replay, stallLine, step, tick, type Stall, type Stalls } from '../src/stall.ts';
import { ownerOf } from '../src/lead.ts';

const T0 = Date.parse('2026-11-10T12:00:00Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, sid: string, event: string, msg = '', prompt = ''): FeedEvent => ({ ts: at(min), sid, event, cwd: `/w/${sid}`, prompt, msg, tail: msg });
const IDLE = 'Claude is waiting for your input';

function run(events: FeedEvent[], endMin?: number) {
  const m: Stalls = new Map();
  const out: Stall[] = [];
  for (const e of events) out.push(...step(m, e));
  if (endMin !== undefined) out.push(...tick(m, T0 + endMin * 60_000));
  return out.map(s => `${s.sid} ${s.streak}: ${s.text}`);
}

test('a turn that ends on an API error stalls at once with the error', () => {
  assert.deepEqual(run([ev(0, 'a', 'UserPromptSubmit', '', 'wire compose'), ev(2, 'a', 'StopFailure', 'API error: unknown | API Error: Connection lost')]),
    ['a 1: API error: unknown | API Error: Connection lost']);
});

test('the netto-proto case: a steer, an idle ping and no Stop stalls 30 minutes after going idle', () => {
  const feed = [ev(0, 'n', 'UserPromptSubmit', '', 'Lucas: leave the external-model question open'), ev(2, 'n', 'Notification', IDLE)];
  assert.deepEqual(run(feed, 31), [], 'not yet');
  assert.deepEqual(run(feed, 32), ['n 1: idle 30 min, no reply to: Lucas: leave the external-model question open']);
  const long = run([ev(0, 'n', 'UserPromptSubmit', '', 'x'.repeat(300)), ev(2, 'n', 'Notification', IDLE)], 40)[0];
  assert.equal(long, `n 1: idle 30 min, no reply to: ${'x'.repeat(150)}`, 'a long prompt keeps the reason');
});

test('an interim Stop that goes idle stalls with its last words', () => {
  assert.deepEqual(run([ev(0, 'i', 'UserPromptSubmit'), ev(5, 'i', 'Stop', 'Still waiting on the two reviewers.'), ev(6, 'i', 'Notification', IDLE)], 40),
    ['i 1: Still waiting on the two reviewers.']);
});

test('a DONE or a question is an answer, not a stall; a finished summary naming reviewers is a DONE', () => {
  assert.deepEqual(run([ev(0, 'd', 'UserPromptSubmit'), ev(5, 'd', 'Stop', 'All tests green, committed.'), ev(6, 'd', 'Notification', IDLE)], 120), []);
  assert.deepEqual(run([ev(0, 'q', 'UserPromptSubmit'), ev(5, 'q', 'Stop', 'Should I push?'), ev(6, 'q', 'Notification', IDLE)], 120), []);
  assert.deepEqual(run([ev(0, 'r', 'UserPromptSubmit'), ev(5, 'r', 'Stop', 'All five reviewers are in; 2 remaining nits fixed. Committed.'), ev(6, 'r', 'Notification', IDLE)], 120), []);
});

test('a permission block holds the clock but a StopFailure after approval still stalls', () => {
  const perm = 'Claude needs your permission to use Bash';
  assert.deepEqual(run([ev(0, 'b', 'UserPromptSubmit'), ev(5, 'b', 'Notification', perm), ev(6, 'b', 'Notification', IDLE)], 120), []);
  assert.deepEqual(run([ev(0, 'b', 'UserPromptSubmit'), ev(5, 'b', 'Notification', perm), ev(20, 'b', 'StopFailure', 'API error: server_error')]),
    ['b 1: API error: server_error']);
});

test('a resume that arrives without a prompt (SendMessage) and stalls again counts as again', () => {
  assert.deepEqual(run([
    ev(0, 's', 'UserPromptSubmit'), ev(1, 's', 'StopFailure', 'API error: unknown'),
    ev(10, 's', 'Stop', 'Picking up: still running the e2e.'), ev(11, 's', 'Notification', IDLE),
  ], 60), ['s 1: API error: unknown', 's 2: Picking up: still running the e2e.']);
  assert.deepEqual(run([ev(0, 's', 'UserPromptSubmit'), ev(1, 's', 'StopFailure', 'API error: unknown'), ev(10, 's', 'StopFailure', 'API error: overloaded')]),
    ['s 1: API error: unknown', 's 2: API error: overloaded']);
});

test('a replay reports only the stalls still current at its end', () => {
  const feed = [
    ev(0, 'r', 'UserPromptSubmit', '', 'go'), ev(2, 'r', 'Notification', IDLE), ev(60, 'r', 'UserPromptSubmit', '', 'resume'), ev(70, 'r', 'Stop', 'Done, committed.'),
    ev(0, 'x', 'UserPromptSubmit'), ev(1, 'x', 'StopFailure', 'API error: rate_limit'), ev(30, 'x', 'Stop', 'Finished after all, committed.'),
    ev(0, 'z', 'UserPromptSubmit'), ev(1, 'z', 'StopFailure', 'API error: rate_limit'),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  const { current } = replay(feed, T0 + 120 * 60_000);
  assert.deepEqual(current.map(s => `${s.sid} ${s.streak}: ${s.text}`), ['z 1: API error: rate_limit']);
});

test('a session that keeps working is no stall, and a new prompt restarts the clock', () => {
  assert.deepEqual(run([ev(0, 'w', 'UserPromptSubmit')], 120), [], 'never went idle');
  assert.deepEqual(run([ev(0, 'w', 'UserPromptSubmit'), ev(2, 'w', 'Notification', IDLE), ev(20, 'w', 'UserPromptSubmit'), ev(22, 'w', 'Notification', IDLE)], 40), []);
  assert.deepEqual(run([ev(0, 'w', 'UserPromptSubmit'), ev(2, 'w', 'Notification', IDLE), ev(10, 'w', 'Stop', 'Now running the e2e.')], 60), [],
    'a Stop after the idle ping means it was working again');
});

test('each stall is reported once; a stall right after a resume counts up, an answer resets the count', () => {
  const feed = [
    ev(0, 'a', 'UserPromptSubmit'), ev(1, 'a', 'StopFailure', 'API error: rate_limit'), ev(40, 'a', 'Notification', IDLE),
    ev(50, 'a', 'UserPromptSubmit', '', 'resume'), ev(51, 'a', 'Notification', IDLE),
  ];
  assert.deepEqual(run(feed, 90), ['a 1: API error: rate_limit', 'a 2: idle 30 min, no reply to: resume']);
  assert.deepEqual(run([...feed, ev(90, 'a', 'Stop', 'Done.'), ev(100, 'a', 'UserPromptSubmit'), ev(101, 'a', 'StopFailure', 'API error: overloaded')]),
    ['a 1: API error: rate_limit', 'a 2: idle 30 min, no reply to: resume', 'a 1: API error: overloaded']);
});

test('the line names the worker and says when it stalled again', () => {
  const st: Stall = { sid: '90a1fb72-xx', cwd: '/w', key: 'k', text: 'API Error: Connection lost', streak: 1 };
  assert.equal(stallLine('netto-proto', 'w5:p1', st), 'STALLED worker netto-proto [w5:p1] 90a1fb72: API Error: Connection lost');
  assert.equal(stallLine('netto-proto', 'w5:p1', { ...st, streak: 2 }), 'STALLED worker netto-proto [w5:p1] 90a1fb72 (again, 2 in a row): API Error: Connection lost');
  assert.equal(ownerOf('STALLED worker idea-74 [w3:p1] 1234abcd: API error', n => n === 'idea-74' ? 'evrloot-next' : undefined), 'evrloot',
    'a lead’s worker stall goes to the lead');
});

const SRC = join(import.meta.dirname, '..', 'src');
const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

function watcher(root: string, stub: string) {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(SRC, 'watch.ts')],
    { env: { ...process.env, ORCH_DIR: root, ORCH_SID: 'orch0001', ORCH_QUEUE: 'off', PATH: `${stub}:${process.env.PATH}` } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => lines.push(l));
  const until = async (pred: (ls: string[]) => boolean) => {
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (pred(lines)) return;
    assert.fail(`timed out; got ${JSON.stringify(lines)}`);
  };
  return { p, lines, until };
}
const kill = (p: ChildProcess) => new Promise(r => { p.on('exit', r); p.kill(); });
const stalled = (ls: string[]) => ls.filter(l => l.startsWith('STALLED'));

test('the watcher says each stalled worker once across re-arms, and a second stall in a row as again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-stall-'));
  for (const d of ['feed', 'leads', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock"}');
  const stub = mkdtempSync(join(tmpdir(), 'herdr-stub-'));
  writeFileSync(join(stub, 'herdr'), '#!/bin/sh\necho \'{"error":{"code":"stub"}}\'\n', { mode: 0o755 });
  const worker = (name: string, sid: string) => ({ name, repo: 'netto', sid, pane: `${name}:p1`, worktree: join(root, name), status: 'running', branch: `orch/${name}`, task: 't', workspace: 'w', started: '' });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([worker('netto-proto', 'net00001'), worker('api-hit', 'api00001'), worker('finished', 'fin00001'), worker('recovered', 'rec00001')]));
  const feed = join(root, 'feed', `${new Date().toLocaleDateString('sv-SE')}.jsonl`);
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const add = (ts: string, sid: string, cwd: string, event: string, msg = '', prompt = '') =>
    appendFileSync(feed, JSON.stringify({ ts, sid, event, cwd: join(root, cwd), prompt, msg, tail: msg }) + '\n');
  add(ago(60), 'net00001', 'netto-proto/app', 'UserPromptSubmit', '', 'Lucas: leave it open');
  add(ago(58), 'net00001', 'netto-proto', 'Notification', IDLE);
  add(ago(50), 'api00001', 'api-hit', 'UserPromptSubmit', '', 'go');
  add(ago(49), 'api00001', 'api-hit', 'StopFailure', 'API error: unknown | API Error: Connection lost');
  add(ago(50), 'fin00001', 'finished', 'UserPromptSubmit', '', 'go');
  add(ago(40), 'fin00001', 'finished', 'Stop', 'All green, committed.');
  add(ago(39), 'fin00001', 'finished', 'Notification', IDLE);
  add(ago(30), 'someone1', 'not-a-worker', 'UserPromptSubmit', '', 'hi');
  add(ago(29), 'someone1', 'not-a-worker', 'StopFailure', 'API error: rate_limit');
  // Another session in a worker's worktree: the worker has a session id, so the folder does not make it the worker.
  add(ago(30), 'helper01', 'finished', 'UserPromptSubmit', '', 'hi');
  add(ago(29), 'helper01', 'finished', 'StopFailure', 'API error: rate_limit');
  // Stalled (idle at -100) and recovered later in the same replay: nothing to say.
  add(ago(102), 'rec00001', 'recovered', 'UserPromptSubmit', '', 'go');
  add(ago(100), 'rec00001', 'recovered', 'Notification', IDLE);
  add(ago(20), 'rec00001', 'recovered', 'UserPromptSubmit', '', 'resume');
  add(ago(10), 'rec00001', 'recovered', 'Stop', 'Done, committed.');

  const first = watcher(root, stub);
  await first.until(ls => stalled(ls).length >= 2);
  await new Promise(r => setTimeout(r, 1000));
  assert.deepEqual(stalled(first.lines).sort(), [
    'STALLED worker api-hit [api-hit:p1] api00001: API error: unknown | API Error: Connection lost',
    'STALLED worker netto-proto [netto-proto:p1] net00001: idle 30 min, no reply to: Lucas: leave it open',
  ]);
  await kill(first.p);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'stalled.json'), 'utf8'))).length, 2);

  const second = watcher(root, stub);
  // Ready once its tail prints a probe, so the lines written next cannot land before it.
  for (const end = Date.now() + 15_000; !second.lines.some(l => l.includes('watcher-probe')); await new Promise(r => setTimeout(r, 200))) {
    if (Date.now() > end) assert.fail('watcher never became ready');
    add(new Date().toISOString(), 'probe000', 'probe', 'Stop', 'watcher-probe');
  }
  assert.deepEqual(stalled(second.lines), [], 'a re-arm says nothing it already said');
  add(new Date().toISOString(), 'api00001', 'api-hit', 'UserPromptSubmit', '', 'Your last turn broke off; continue.');
  add(new Date().toISOString(), 'api00001', 'api-hit', 'StopFailure', 'API error: overloaded');
  await second.until(ls => stalled(ls).length >= 1);
  assert.deepEqual(stalled(second.lines), ['STALLED worker api-hit [api-hit:p1] api00001 (again, 2 in a row): API error: overloaded']);
  await kill(second.p);
});
