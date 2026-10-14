import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeedEvent, Snapshot } from '../src/board.ts';
import { buildState, feedReader, lastActions, parseDecision, parseSnapshot, redact, type WorkerRecord } from '../src/state.ts';

const now = Date.parse('2026-10-14T12:00:00Z');
const agent = (sid: string, pane: string, ws: string, status: string, extra: object = {}) => ({
  agent: 'claude', agent_session: { value: sid }, agent_status: status, pane_id: pane, workspace_id: ws, cwd: '/c/' + sid, ...extra,
});
const ev = (sid: string, event: string, sec: number, f: Partial<FeedEvent> = {}): FeedEvent =>
  ({ ts: new Date(now - sec * 1000).toISOString(), sid, event, cwd: '', prompt: '', msg: '', ...f });
const snapWith = (orchStatus: string, extra: ReturnType<typeof agent>[] = []): Snapshot => ({
  workspaces: [{ workspace_id: 'w9', label: 'orch' }, { workspace_id: 'w1', label: 'code' }],
  agents: [agent('orch', 'w9:p1', 'w9', orchStatus), ...extra],
});
const state = (snap: Snapshot, feed: FeedEvent[] = [], more: Partial<Parameters<typeof buildState>[0]> = {}) =>
  buildState({ snap, feed, workers: [], decisions: [], log: '', now, ...more });

test('orch mood follows its own session', () => {
  assert.equal(state(snapWith('idle')).orch.state, 'idle');
  assert.equal(state(snapWith('blocked')).orch.state, 'blocked');
  assert.equal(state(snapWith('working'), [ev('orch', 'UserPromptSubmit', 5)]).orch.state, 'thinking');
  assert.equal(state(snapWith('working'), [ev('orch', 'UserPromptSubmit', 60)]).orch.state, 'working');
});

test('orch waits on the user when a decision is open or its last reply asks something', () => {
  const open = [{ id: 'D-12', status: 'open', question: 'Merge #130?' }, { id: 'D-11', status: 'accepted', question: 'old' }];
  const s = state(snapWith('done'), [], { decisions: open });
  assert.equal(s.orch.state, 'waiting');
  assert.deepEqual(s.decisions, [{ id: 'D-12', question: 'Merge #130?' }]);
  assert.equal(state(snapWith('done'), [ev('orch', 'Stop', 10, { msg: 'Push it now?' })]).orch.state, 'waiting');
  assert.equal(state(snapWith('done'), [ev('orch', 'Stop', 10, { msg: 'Pushed.' })]).orch.state, 'idle');
});

test('a session named orch wins over the orch workspace', () => {
  const snap = snapWith('idle', [agent('named', 'w1:p1', 'w1', 'blocked', { name: 'orch' })]);
  assert.equal(state(snap).orch.state, 'blocked');
});

test('in the orch workspace, the session that spoke last is orch', () => {
  const snap = snapWith('idle', [agent('side', 'w9:p2', 'w9', 'blocked')]);
  assert.equal(state(snap, [ev('orch', 'Stop', 300), ev('side', 'Stop', 5)]).orch.state, 'blocked');
  assert.equal(state(snap, [ev('orch', 'Stop', 5), ev('side', 'Stop', 300)]).orch.state, 'idle');
});

test('workers carry status, last line and skip closed ones', () => {
  const w = (name: string, pane: string, status = 'running'): WorkerRecord =>
    ({ name, repo: 'tariffs', status, sid: name, pane, started: '2026-10-14 09:00' });
  const snap = snapWith('working', [
    agent('a', 'w2:p1', 'w2', 'working'), agent('b', 'w3:p1', 'w3', 'done'),
    agent('c', 'w4:p1', 'w4', 'blocked'), agent('d', 'w5:p1', 'w5', 'done'), agent('e', 'w6:p1', 'w6', 'idle'),
  ]);
  const feed = [
    ev('b', 'Stop', 30, { msg: 'Fixed the join.\n\n**Gates green.**' }),
    ev('d', 'Stop', 30, { msg: 'Two options.', tail: 'Should I keep the old API?' }),
  ];
  const workers = [w('a', 'w2:p1'), w('b', 'w3:p1'), w('c', 'w4:p1'), w('d', 'w5:p1'), w('e', 'w6:p1'), w('gone', 'w7:p1'), w('old', 'w8:p1', 'closed')];
  const s = state(snap, feed, { workers });
  assert.deepEqual(s.workers.map(x => [x.name, x.status]),
    [['a', 'working'], ['b', 'done'], ['c', 'blocked'], ['d', 'asking'], ['e', 'idle'], ['gone', 'done']]);
  assert.equal(s.workers[1].said, 'Gates green.');
  assert.equal(s.workers[3].said, 'Should I keep the old API?');
  assert.deepEqual(s.workers[0], { name: 'a', repo: 'tariffs', kind: 'claude', status: 'working', said: '', started: '2026-10-14 09:00' });
});

test('codex workers are found by worktree', () => {
  const snap = snapWith('idle', [{ ...agent('x', 'w2:p1', 'w2', 'done'), agent_session: {} } as any]);
  const workers = [{ name: 'cx', repo: 'r', kind: 'codex', status: 'running', pane: 'w2:p1', worktree: '/wt/cx' }];
  const s = state(snap, [ev('codex-1', 'Stop', 10, { cwd: '/wt/cx', msg: 'Done, tests pass.' })], { workers });
  assert.deepEqual([s.workers[0].kind, s.workers[0].said], ['codex', 'Done, tests pass.']);
});

test('other sessions are counted by state, without orch and workers', () => {
  const snap = snapWith('idle', [agent('a', 'w1:p1', 'w1', 'idle'), agent('b', 'w1:p2', 'w1', 'idle'), agent('c', 'w1:p3', 'w1', 'blocked'), agent('wk', 'w2:p1', 'w2', 'working')]);
  const s = state(snap, [], { workers: [{ name: 'wk', repo: 'r', status: 'running', pane: 'w2:p1' }] });
  assert.deepEqual(s.sessions, { idle: 2, blocked: 1 });
});

test('last five actions from the log, time only', () => {
  const log = '# log\n\n' + Array.from({ length: 7 }, (_, i) => `- 2026-10-14 1${i}:00 action ${i}`).join('\n') + '\n  continuation\n';
  assert.deepEqual(lastActions(log), ['12:00 action 2', '13:00 action 3', '14:00 action 4', '15:00 action 5', '16:00 action 6']);
});

test('decision header and status are parsed', () => {
  assert.deepEqual(parseDecision('D-03', '# D-03: Push the fix?\n\n- Status: accepted\n'), { id: 'D-03', status: 'accepted', question: 'Push the fix?' });
});

test('the state stays small and holds no prompts', () => {
  const long = 'x'.repeat(5000);
  const snap = snapWith('idle', Array.from({ length: 30 }, (_, i) => agent(`s${i}`, `w${i}:p1`, `w${i}`, 'working')));
  const workers = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, repo: 'r', status: 'running', sid: `s${i}`, pane: `w${i}:p1` }));
  const feed = workers.flatMap(w => [ev(w.sid, 'UserPromptSubmit', 20, { prompt: 'SECRET ' + long }), ev(w.sid, 'Stop', 10, { msg: long })]);
  const decisions = Array.from({ length: 20 }, (_, i) => ({ id: `D-${i}`, status: 'open', question: long }));
  const text = JSON.stringify(state(snap, feed, { workers, decisions, log: `- 2026-10-14 10:00 ${long}\n`.repeat(9) }));
  assert.ok(text.length < 20_000, `${text.length} bytes`);
  assert.ok(!text.includes('SECRET'));
});

test('a failed or malformed herdr snapshot is null, so nothing is published', () => {
  assert.equal(parseSnapshot(''), null);
  assert.equal(parseSnapshot('{"error":{"code":"timeout"}}'), null);
  assert.equal(parseSnapshot('{"result":{"snapshot":{"agents":[]}}}'), null);
  assert.deepEqual(parseSnapshot('{"result":{"snapshot":{"workspaces":[],"agents":[]}}}'), { workspaces: [], agents: [] });
});

test('the feed reader keeps yesterday after midnight and reads only appended bytes', () => {
  const files: Record<string, string> = {};
  const reads: [string, number][] = [];
  const read = feedReader((f, offset) => { reads.push([f, offset]); return (files[f] ?? '').slice(offset); });
  const line = (sid: string, event: string, msg = '') => JSON.stringify({ ts: '2026-10-14T23:00:00Z', sid, event, cwd: '', prompt: '', msg }) + '\n';

  files['2026-10-14'] = line('w', 'Stop', 'Should I keep the old API?');
  assert.deepEqual(read(['2026-10-13', '2026-10-14']).map(e => e.msg), ['Should I keep the old API?']);
  files['2026-10-14'] += line('o', 'UserPromptSubmit');
  assert.equal(read(['2026-10-13', '2026-10-14']).length, 2);
  assert.deepEqual(reads.filter(r => r[0] === '2026-10-14').map(r => r[1]), [0, files['2026-10-14'].length - line('o', 'UserPromptSubmit').length]);

  // Midnight: the window moves to (14, 15); the open question from the 14th is still there.
  files['2026-10-15'] = line('o', 'Stop', 'ok');
  const after = read(['2026-10-14', '2026-10-15']);
  assert.deepEqual(after.map(e => e.sid), ['w', 'o', 'o']);
  const s = buildState({ snap: { workspaces: [], agents: [agent('w', 'w2:p1', 'w2', 'done')] }, feed: after,
    workers: [{ name: 'w', repo: 'r', status: 'running', sid: 'w', pane: 'w2:p1' }], decisions: [], log: '', now });
  assert.equal(s.workers[0].status, 'asking');

  // A day that left the window is dropped.
  assert.deepEqual(read(['2026-10-15', '2026-10-16']).map(e => e.msg), ['ok']);
});

test('a half-written line waits for the rest', () => {
  let text = '{"sid":"a","event":"Stop"}\n{"sid":"b",';
  const read = feedReader((_, offset) => text.slice(offset));
  assert.deepEqual(read(['d']).map(e => e.sid), ['a']);
  text += '"event":"Stop"}\n';
  assert.deepEqual(read(['d']).map(e => e.sid), ['a', 'b']);
});

test('credentials are masked in everything that is synced', () => {
  assert.equal(redact('set ANTHROPIC key sk-ant-api03-AbCdEf123456_xyz and go'), 'set ANTHROPIC key [redacted] and go');
  assert.equal(redact('Jira token ATATT3xFfGF0abcDEF123'), 'Jira token [redacted]');
  assert.equal(redact('pushed with ghp_1234567890abcdefABCDEF1234567890abcd'), 'pushed with [redacted]');
  assert.equal(redact('password=hunter2secret, next'), 'password=[redacted], next');
  assert.equal(redact('API_KEY: "abcd1234efgh"'), 'API_KEY: [redacted]');
  assert.equal(redact('Authorization: Bearer abc.def.ghi1'), 'Authorization: Bearer [redacted]');
  assert.equal(redact('sha 3f2a9c1e5b7d4f6a8c0e2b4d6f8a0c2e done'), 'sha [redacted] done');
  assert.equal(redact('blob Zm9vYmFyQmF6MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1u end'), 'blob [redacted] end');
  const plain = 'Fixed internal/dutyline/service.go:356 in orch/zolt144, commit 8c4deda, ZOLT-127-retrigger-extraction-worktree';
  assert.equal(redact(plain), plain);
});

test('a secret in the last reply never reaches the state, and lines stay short', () => {
  const snap = snapWith('done');
  const said = state(snap, [ev('orch', 'Stop', 5, { msg: 'Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 ' + 'and more words '.repeat(20) })]).orch.said;
  assert.ok(!said.includes('ghp_'), said);
  assert.ok(said.startsWith('Use [redacted] and more'), said);
  assert.ok(said.length <= 120, `${said.length}`);
});
