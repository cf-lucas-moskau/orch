import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFps, nextSprites, nextWake, petMood, reconcile, waitingCount, type OrchState, type WorkerView } from '../src/model.ts';

const w = (name: string, status: WorkerView['status'] = 'working'): WorkerView =>
  ({ name, repo: 'r', kind: 'claude', status, said: '', started: '' });
const state = (over: Partial<OrchState> = {}): OrchState => ({
  v: 1, ts: '2026-10-14T12:00:00.000Z', orch: { state: 'working', said: '' }, workers: [], decisions: [], sessions: {}, actions: [], ...over,
});
const t0 = Date.parse('2026-10-14T12:00:00Z');
const phases = (s: ReturnType<typeof reconcile>) => s.map(x => `${x.worker.name}:${x.phase}`);

test('the pet sleeps without a state or when the feed is older than a minute', () => {
  assert.equal(petMood(null, t0), 'asleep');
  assert.equal(petMood(state(), t0 + 59_000), 'working');
  assert.equal(petMood(state(), t0 + 61_000), 'asleep');
});

test('the badge counts open decisions and workers that ask or are blocked', () => {
  const s = state({ decisions: [{ id: 'D-1', question: 'q' }], workers: [w('a', 'asking'), w('b', 'blocked'), w('c', 'done')] });
  assert.equal(waitingCount(s), 3);
});

test('first state shows workers without replaying arrivals', () => {
  assert.deepEqual(phases(reconcile(null, [w('a'), w('b')], t0)), ['a:here', 'b:here']);
});

test('a new worker arrives, then settles', () => {
  const s = reconcile([], [w('a')], t0);
  assert.deepEqual(phases(s), ['a:arriving']);
  assert.equal(nextWake(s, null, t0), t0 + 1400);
  assert.deepEqual(phases(reconcile(s, [w('a')], t0 + 1500)), ['a:here']);
});

test('finishing cheers once, then the worker stays put', () => {
  const s = reconcile(reconcile(null, [w('a')], t0), [w('a', 'done')], t0);
  assert.deepEqual(phases(s), ['a:cheering']);
  assert.deepEqual(phases(reconcile(s, [w('a', 'done')], t0 + 1000)), ['a:cheering']);
  assert.deepEqual(phases(reconcile(s, [w('a', 'done')], t0 + 3000)), ['a:here']);
});

test('a cleaned-up worker walks off, then is gone', () => {
  const s = reconcile(reconcile(null, [w('a'), w('b')], t0), [w('b')], t0);
  assert.deepEqual(phases(s), ['a:leaving', 'b:here']);
  assert.equal(s[0].worker.name, 'a');
  assert.deepEqual(phases(reconcile(s, [w('b')], t0 + 1000)), ['a:leaving', 'b:here']);
  assert.deepEqual(phases(reconcile(s, [w('b')], t0 + 2000)), ['b:here']);
});

test('a worker that comes back while leaving stays', () => {
  const s = reconcile(reconcile(null, [w('a')], t0), [], t0);
  const back = reconcile(s, [w('a', 'idle')], t0 + 500);
  assert.deepEqual(back, [{ worker: w('a', 'idle'), phase: 'here', until: 0 }]);
});

test('the renderer wakes when a phase ends or the feed goes stale, never for the past', () => {
  const here = reconcile(null, [w('a')], t0);
  assert.equal(nextWake(here, null, t0), Infinity);
  assert.equal(nextWake(here, state(), t0 + 1000), t0 + 60_001);
  assert.equal(nextWake(here, state(), t0 + 61_000), Infinity);
  assert.equal(nextWake(reconcile([], [w('b')], t0 + 59_000), state(), t0 + 59_000), t0 + 60_001);
});

test('poses only flip while something moves', () => {
  const idle = reconcile(null, [w('a', 'idle'), w('b', 'done')], t0);
  assert.equal(motionFps('idle', idle), 0);
  assert.equal(motionFps('idle', reconcile(null, [w('a', 'asking')], t0)), 8);
  assert.equal(motionFps('working', idle), 8);
  assert.equal(motionFps('asleep', reconcile(null, [w('a')], t0)), 2);
});

test('the first real state after launch shows workers in place, even after an empty start', () => {
  const s = state({ workers: [w('a'), w('b')] });
  const boot = nextSprites(null, null, t0);
  assert.equal(boot, null);
  assert.deepEqual(phases(nextSprites(boot, s, t0)!), ['a:here', 'b:here']);
  assert.deepEqual(phases(nextSprites(nextSprites(boot, s, t0), state({ workers: [w('a'), w('b'), w('c')] }), t0)!), ['a:here', 'b:here', 'c:arriving']);
});
