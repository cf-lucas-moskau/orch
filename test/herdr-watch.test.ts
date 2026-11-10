import { test } from 'node:test';
import assert from 'node:assert/strict';
import { follow, herdrFollowed, settleKey, type Followed, type HerdrReply } from '../src/herdr-watch.ts';

type Step = { call: 'get' | 'wait'; until?: string[]; reply: HerdrReply };
const agent = (agent_status: string, seq: number, completion_seq?: number): HerdrReply =>
  ({ result: { agent: { agent_status, state_change_seq: seq, ...(completion_seq ? { completion_seq } : {}) } } });
const err = (code: string): HerdrReply => ({ error: { code } });
const get = (reply: HerdrReply): Step => ({ call: 'get', reply });
const untilWorking = (reply: HerdrReply): Step => ({ call: 'wait', until: ['working'], reply });
const settled = (reply: HerdrReply): Step => ({ call: 'wait', until: [], reply });

// A fake herdr answering from a script; the follower stops once the script runs out.
async function run(script: Step[], seed = false) {
  let i = 0, done = false;
  const emits: string[] = [], sleeps: number[] = [];
  const step = (call: Step['call'], until?: string[]): Promise<HerdrReply> => {
    const s = script[i++];
    if (!s) { done = true; return Promise.resolve(err('end')); }
    assert.equal(call, s.call, `step ${i}`);
    if (until) assert.deepEqual(until, s.until, `step ${i}`);
    return Promise.resolve(s.reply);
  };
  await follow({
    get: () => step('get'), wait: u => step('wait', u),
    sleep: async ms => { sleeps.push(ms); }, emit: (k, a) => { emits.push(`${k} ${a.agent_status}`); },
  }, () => !done, seed);
  return { emits, sleeps };
}

test('a finish before the watcher found the worker is reported once', async () => {
  const r = await run([get(agent('done', 10, 10)), untilWorking(err('timeout')), get(agent('done', 10, 10))]);
  assert.deepEqual(r.emits, ['done done']);
  assert.deepEqual(r.sleeps, [], 'a timeout starts the next round without a pause');
});

test('a watcher re-arm takes the state at start as known', async () => {
  const r = await run([get(agent('done', 10, 10)), untilWorking(err('timeout')), get(agent('idle', 11, 10))], true);
  assert.deepEqual(r.emits, [], 'done turning idle (a focus) is the same finish');
});

test('each turn is reported once, though herdr shows its finish twice', async () => {
  const r = await run([
    get(agent('working', 11)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12)),
    get(agent('done', 12, 12)), untilWorking(agent('working', 13)), settled(agent('done', 14, 14)),
  ]);
  assert.deepEqual(r.emits, ['done done', 'done done']);
});

test('failed waits retry and look again, so a finish during the failure counts', async () => {
  const r = await run([
    get(agent('working', 11)), untilWorking(err('unparsed')),
    get(agent('working', 11)), untilWorking(agent('working', 11)), settled(err('agent_not_found')),
    get(agent('done', 12, 12)),
  ]);
  assert.deepEqual(r.emits, ['done done']);
  assert.deepEqual(r.sleeps, [5000, 5000]);
});

test('a block, answered, then a finish: two reports', async () => {
  const r = await run([
    get(agent('working', 11)), untilWorking(agent('working', 11)), settled(agent('blocked', 12)),
    get(agent('blocked', 12)), untilWorking(agent('working', 13)), settled(agent('done', 14, 14)),
  ]);
  assert.deepEqual(r.emits, ['blocked blocked', 'done done']);
});

test('herdr follows only prompted workers without a session id or hook events', () => {
  const w = (over: Partial<Followed>): Followed =>
    ({ name: 'cx', pane: 'w9:p1', worktree: '/wt/cx', sid: '', status: 'running', prompted: '2026-11-09 15:00', ...over });
  const hooked = new Set(['/wt/hooked']);
  assert.deepEqual(herdrFollowed([
    w({}),
    w({ name: 'claude', sid: 'abc' }),
    w({ name: 'fresh', prompted: undefined }),
    w({ name: 'hooks', worktree: '/wt/hooked' }),
    w({ name: 'closed', status: 'closed' }),
  ], hooked).map(x => x.name), ['cx']);
});

test('settle keys', () => {
  assert.equal(settleKey({ agent_status: 'done', state_change_seq: 9, completion_seq: 7 }), 'settled 7');
  assert.equal(settleKey({ agent_status: 'idle', state_change_seq: 9 }), 'settled 9');
  assert.equal(settleKey({ agent_status: 'blocked', state_change_seq: 9 }), 'blocked 9');
  assert.equal(settleKey({ agent_status: 'working', state_change_seq: 9 }), null);
});
