import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBoard, renderBoard, type Snapshot, type FeedEvent } from '../src/board.ts';

const now = Date.parse('2026-10-05T12:00:00Z');
const agent = (sid: string, pane: string, ws: string, status: string, extra: object = {}) => ({
  agent: 'claude', agent_session: { value: sid }, agent_status: status, pane_id: pane,
  workspace_id: ws, cwd: '/home/me/code/' + sid, focused: false, ...extra,
});
const snap: Snapshot = {
  workspaces: [{ workspace_id: 'w1', label: 'tariffs' }, { workspace_id: 'w2', label: 'code' }, { workspace_id: 'w9', label: 'orch' }],
  agents: [
    agent('a', 'w1:p1', 'w1', 'idle', { terminal_title_stripped: 'Go DB pool' }),
    agent('b', 'w1:p2', 'w1', 'working', { name: 'worker-1' }),
    agent('c', 'w2:p1', 'w2', 'blocked', { terminal_title_stripped: 'Claude Code' }),
    agent('self', 'w9:p1', 'w9', 'working', { cwd: '/home/me/orch' }),
  ],
};
const ev = (sid: string, event: string, min: number, f: Partial<FeedEvent> = {}): FeedEvent =>
  ({ ts: new Date(now - min * 60000).toISOString(), sid, event, cwd: '', prompt: '', msg: '', ...f });
const feed: FeedEvent[] = [
  ev('a', 'UserPromptSubmit', 30, { prompt: 'old ask' }),
  ev('a', 'UserPromptSubmit', 20, { prompt: 'add pool | metrics' }),
  ev('a', 'Stop', 15, { msg: 'Pool done,\ntests green' }),
  ev('c', 'Notification', 2, { msg: 'Claude needs your permission to use Bash' }),
  ev('zombie', 'Stop', 1, { msg: 'gone session' }),
];

test('one row per live agent, excluding orch itself', () => {
  const rows = buildBoard(snap, feed, now, { selfCwd: '/home/me/orch' });
  assert.deepEqual(rows.map(r => r.sid).sort(), ['a', 'b', 'c']);
});

test('blocked first, then working, then the rest by last activity', () => {
  const rows = buildBoard(snap, feed, now, { selfCwd: '/home/me/orch' });
  assert.deepEqual(rows.map(r => r.sid), ['c', 'b', 'a']);
});

test('row carries workspace, name, latest ask, last reply and age', () => {
  const a = buildBoard(snap, feed, now, {}).find(r => r.sid === 'a')!;
  assert.equal(a.workspace, 'tariffs');
  assert.equal(a.name, 'Go DB pool');
  assert.equal(a.asked, 'add pool | metrics');
  assert.equal(a.said, 'Pool done, tests green');
  assert.equal(a.movedMin, 15);
});

test('name falls back from herdr name to title to workspace:pane', () => {
  const rows = buildBoard(snap, feed, now, {});
  assert.equal(rows.find(r => r.sid === 'b')!.name, 'worker-1');
  assert.equal(rows.find(r => r.sid === 'c')!.name, 'code w2:p1');
});

test('blocked rows show the pending notification', () => {
  const c = buildBoard(snap, feed, now, {}).find(r => r.sid === 'c')!;
  assert.equal(c.waitingOn, 'Claude needs your permission to use Bash');
});

test('repo and branch come from the cwd map', () => {
  const rows = buildBoard(snap, feed, now, { repos: { '/home/me/code/a': { repo: 'tariffs', branch: 'feat/db-pool' } } });
  assert.equal(rows.find(r => r.sid === 'a')!.repo, 'tariffs@feat/db-pool');
});

test('markdown escapes pipes and truncates long text', () => {
  const md = renderBoard(buildBoard(snap, [...feed, ev('b', 'UserPromptSubmit', 1, { prompt: 'x'.repeat(200) })], now, { selfCwd: '/home/me/orch' }), now);
  assert.match(md, /add pool \\\| metrics/);
  assert.ok(!md.includes('x'.repeat(100)));
  assert.match(md, /^# board/m);
  assert.equal(md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Session') ).length, 3);
});

test('codex panes without a herdr session id are joined to the feed by cwd', () => {
  const snap = { workspaces: [{ workspace_id: 'w1', label: 'code' }], agents: [
    { agent: 'codex', agent_status: 'done', pane_id: 'w1:p2', workspace_id: 'w1', cwd: '/r/app' },
    { agent: 'codex', agent_status: 'idle', pane_id: 'w1:p3', workspace_id: 'w1', cwd: '/r/never-prompted' },
  ] };
  const feed = [
    { ts: '2026-10-07T10:00:00Z', sid: 'old', event: 'Stop', cwd: '/r/app', prompt: '', msg: 'old', agent: 'codex' },
    { ts: '2026-10-07T11:00:00Z', sid: 'cx', event: 'Stop', cwd: '/r/app', prompt: '', msg: 'Fixed it.', agent: 'codex' },
    { ts: '2026-10-07T12:00:00Z', sid: 'cl', event: 'Stop', cwd: '/r/app', prompt: '', msg: 'claude here', agent: 'claude' },
  ];
  const rows = buildBoard(snap, feed, Date.parse('2026-10-07T12:00:00Z'), {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sid, 'cx');
  assert.equal(rows[0].said, 'Fixed it.');
  assert.match(rows[0].name, /\(codex\)$/);
});
