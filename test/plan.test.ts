import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextTasks, parsePlan, setTaskState } from '../src/plan.ts';
import type { Worker } from '../src/dispatch.ts';

const md = `# orch
Goal: orch runs the user's agents
Milestone: step 3 proven

## Tasks
- [x] board: read-only board
- [~] watch: watcher in repo
- [ ] dispatch: orch run end to end
- [!] reflect: nightly job (D-03)
- [ ] brief: morning brief
- [ ] prune: weekly prune
`;

const w = (name: string): Worker =>
  ({ name, repo: 'orch', task: '', branch: '', worktree: '', workspace: '', pane: '', sid: '', started: '', status: 'running' });

test('plan fields and task states parse', () => {
  const p = parsePlan(md);
  assert.equal(p.project, 'orch');
  assert.equal(p.milestone, 'step 3 proven');
  assert.deepEqual(p.tasks.map(t => t.state), ['done', 'running', 'open', 'blocked', 'open', 'open']);
});

test('next tasks fill free slots with open tasks in order', () => {
  const p = parsePlan(md);
  assert.deepEqual(nextTasks(p, [w('watch')], 3).map(t => t.slug), ['dispatch', 'brief']);
  assert.deepEqual(nextTasks(p, [w('watch'), w('x'), w('y')], 3), []);
  assert.deepEqual(nextTasks(p, [w('dispatch')], 4).map(t => t.slug), ['brief', 'prune']);
});

test('task state round-trips', () => {
  const out = setTaskState(md, 'dispatch', 'running');
  assert.match(out, /- \[~\] dispatch: orch run end to end/);
  assert.equal(parsePlan(setTaskState(out, 'dispatch', 'done')).tasks[2].state, 'done');
});

test('kind tags parse and both-tasks take two slots', () => {
  const p = parsePlan('# x\n- [ ] auth: rework token refresh (both)\n- [ ] docs: update README (codex)\n- [ ] lint: fix lint\n');
  assert.deepEqual(p.tasks.map(t => [t.slug, t.kind, t.text]), [
    ['auth', 'both', 'rework token refresh'], ['docs', 'codex', 'update README'], ['lint', 'claude', 'fix lint']]);
  assert.deepEqual(nextTasks(p, [], 2).map(t => t.slug), ['auth']);
  assert.deepEqual(nextTasks(p, [], 3).map(t => t.slug), ['auth', 'docs']);
  const pairRunning = [{ ...w('auth-cl'), pair: 'auth' }, { ...w('auth-cx'), pair: 'auth' }];
  assert.deepEqual(nextTasks(p, pairRunning, 4).map(t => t.slug), ['docs', 'lint']);
  assert.match(setTaskState('- [ ] auth: rework token refresh (both)', 'auth', 'running'), /\[~\] auth: rework token refresh \(both\)/);
});
