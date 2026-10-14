import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeck, edge, flowFromCall, flowsFromLog, parseDecision, parseFeed, stageOf, statusLine, type FeedEvent, type Worker } from '../mod/hooks/core.ts';

const now = Date.parse('2026-10-09T10:30:00Z');
const ev = (sid: string, event: string, ts: string, o: Partial<FeedEvent> = {}): FeedEvent =>
  ({ ts: `2026-10-09T${ts}:00Z`, sid, event, cwd: '/w', prompt: '', msg: '', ...o });
const worker = (o: Partial<Worker> = {}): Worker =>
  ({ name: 'admin-fix', kind: 'claude', repo: 'tariffs', task: 'fix the dashboard', branch: 'orch/admin-fix', pane: 'wY:p1', sid: 'w1', started: '2026-10-09 10:12', status: 'running', ...o });

test('feed parsing skips a half-written last line', () => {
  const text = `${JSON.stringify(ev('a', 'Stop', '10:00', { msg: 'done' }))}\n{"ts":"2026-10-09T10:01`;
  assert.equal(parseFeed(text).length, 1);
});

test('a decision file reads its question, status and recommendation', () => {
  const d = parseDecision('D-05', '# D-05: PR #117: gaps doc only?\n\n- Session: x (tariffs, w4:p5)\n- Opened: 2026-10-06 14:44\n- Status: open\n\n## Recommendation\nOption 1. Ship it.\n\n## Outcome\n');
  assert.deepEqual([d.question, d.status, d.recommendation], ['PR #117: gaps doc only?', 'open', 'Option 1. Ship it.']);
});

test('stage follows orch log lines after the worker started', () => {
  const w = worker({ pair: 'fix', name: 'fix-cl', branch: 'orch/fix-cl' });
  const log = ['- 2026-10-09 09:00 gates fix-cl: all passed', '- 2026-10-09 10:20 gates fix-cl: all passed'];
  assert.equal(stageOf(w, [], []), 'brief');
  assert.equal(stageOf(w, [], [ev('w1', 'UserPromptSubmit', '10:13')]), 'work');
  assert.equal(stageOf(w, log, []), 'gates');
  assert.equal(stageOf(w, [...log, '- 2026-10-09 10:25 review tariffs orch/fix-cl: 1 agreed'], []), 'review');
  assert.equal(stageOf(w, [...log, '- 2026-10-09 10:26 judge fix: fix-cl (gates)'], []), 'judge');
  assert.equal(stageOf(w, [...log, '- 2026-10-09 10:28 push fix-cl: HEAD -> origin/x'], []), 'push');
});

test('deck puts workers first, needs-you before working, folds idle sessions and skips orch itself', () => {
  const feed = [
    ev('w1', 'UserPromptSubmit', '10:13', { prompt: 'You are worker admin-fix' }),
    ev('s2', 'Stop', '10:20', { msg: 'Shall I push it?', tail: 'Shall I push it?' }),
    ev('s3', 'Stop', '08:00', { msg: 'all done' }),
    ev('s4', 'Notification', '10:25', { msg: 'Claude needs your permission to use Bash' }),
    ev('me', 'Stop', '10:29', { cwd: '/orch', msg: 'orch talking' }),
  ];
  const d = buildDeck({ feed, sessions: { s2: { pane: 'w2:p1', workspace: 'x', name: 'tariffs-main', cwd: '/w', kind: 'claude' } }, workers: [worker()], decisions: [], log: [], now, selfCwd: '/orch' });
  assert.deepEqual(d.nodes.map(n => [n.name, n.status]), [['admin-fix', 'working'], ['s4', 'blocked'], ['tariffs-main', 'question']]);
  assert.equal(d.idle, 1);
  assert.deepEqual(d.bus.map(b => b.kind), ['relay', 'prompt', 'needs', 'needs']);
  assert.ok(!d.bus.some(b => b.text.includes('orch talking')));
});

test('an edge carries a dot only while traffic is fresh, pointing the way it went', () => {
  assert.equal(edge(4, { lastTs: '2026-10-09T10:00:00Z', lastEvent: 'Stop' }, now, 0).text, '────▶');
  const out = edge(4, { lastTs: '2026-10-09T10:29:55Z', lastEvent: 'UserPromptSubmit' }, now, 1);
  assert.deepEqual([out.text, out.isLive], ['━●━━▶', true]);
  assert.equal(edge(4, { lastTs: '2026-10-09T10:29:55Z', lastEvent: 'Stop' }, now, 1).text, '━━●━◀');
});

test("flows come from orch's log and its own tool calls", () => {
  const f = flowsFromLog(['- 2026-10-09 10:12 run admin-fix (claude) on tariffs', '- 2026-10-09 10:20 D-06 accepted', '- 17:22 Opened D-02', 'noise']);
  assert.deepEqual(f.map(x => x.flow), ['dispatch', 'decisions']);
  assert.equal(flowFromCall('Skill', { skill: 'orch-prs' })?.flow, 'prs');
  assert.deepEqual(flowFromCall('Bash', { command: 'npm run -s orch -- judge fix' }), { flow: 'review', detail: 'judge fix' });
  assert.equal(flowFromCall('Bash', { command: 'ls' }), null);
});

test('status line counts work and what needs the user', () => {
  const d = buildDeck({ feed: [ev('w1', 'UserPromptSubmit', '10:13', { prompt: 'x' })], sessions: {}, workers: [worker()], decisions: [parseDecision('D-07', '# D-07: push?\n- Status: open')], log: [], now, selfCwd: '/orch' });
  assert.equal(statusLine(d), 'orch · 1 working · 1 need you · D-07');
});
