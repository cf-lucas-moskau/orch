import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedEvent, follow, herdrSettled, newWatch, settleKey, working, type HerdrReply, type Watch } from '../src/herdr-watch.ts';

type Step = { call: 'get' | 'wait'; until?: string[]; reply: HerdrReply; then?: () => void };
const agent = (agent_status: string, seq: number, completion_seq?: number): HerdrReply =>
  ({ result: { agent: { agent_status, state_change_seq: seq, ...(completion_seq ? { completion_seq } : {}) } } });
const err = (code: string): HerdrReply => ({ error: { code } });
const get = (reply: HerdrReply, then?: () => void): Step => ({ call: 'get', reply, then });
const untilWorking = (reply: HerdrReply, then?: () => void): Step => ({ call: 'wait', until: ['working'], reply, then });
const settled = (reply: HerdrReply, then?: () => void): Step => ({ call: 'wait', until: [], reply, then });

// A fake herdr that answers from a script; the follower stops once the script runs out. Grace timers run when
// flush() is called, and all of them at the end.
function harness(start: Watch = newWatch()) {
  let w = start, i = 0, done = false;
  const emits: string[] = [], sleeps: number[] = [], timers: (() => void)[] = [];
  let script: Step[] = [];
  const step = (call: Step['call'], until?: string[]): Promise<HerdrReply> => {
    const s = script[i++];
    if (!s) { done = true; return Promise.resolve(err('end')); }
    assert.equal(call, s.call, `step ${i}`);
    if (until) assert.deepEqual(until, s.until, `step ${i}`);
    s.then?.();
    return Promise.resolve(s.reply);
  };
  const h = {
    emits, sleeps,
    watch: () => w,
    feed: (event: string) => { const r = feedEvent(w, { event }); w = r.w; return r.print; },
    flush: () => { while (timers.length) timers.shift()!(); },
    run: async (steps: Step[], seed = false) => {
      script = steps;
      await follow({
        get: () => step('get'), wait: u => step('wait', u),
        sleep: async ms => { sleeps.push(ms); }, later: (_, f) => { timers.push(f); },
        watch: () => w, save: x => { w = x; }, emit: (k, a) => { emits.push(`${k} ${a.agent_status}`); },
      }, () => !done, seed);
      h.flush();
      return h;
    },
  };
  return h;
}

test('a finish before the watcher found the worker is reported once', async () => {
  const h = await harness().run([get(agent('done', 10, 10)), untilWorking(err('timeout')), get(agent('done', 10, 10))]);
  assert.deepEqual(h.emits, ['done done']);
  assert.equal(h.watch().handled, 'settled 10');
  assert.deepEqual(h.sleeps, [], 'a timeout starts the next round without a pause');
});

test('the first run seeds settled states, a restart skips what it handled', async () => {
  const seeded = await harness().run([get(agent('idle', 10, 10))], true);
  assert.deepEqual(seeded.emits, []);
  assert.equal(seeded.watch().handled, 'settled 10');
  const restarted = await harness(newWatch('settled 10')).run([get(agent('idle', 11, 10))]);
  assert.deepEqual(restarted.emits, [], 'done turning idle (a focus) is the same finish');
});

test('a turn the hooks missed is reported once, though herdr shows it twice', async () => {
  const h = await harness(newWatch('settled 5')).run([
    get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12)), get(agent('done', 12, 12)),
  ]);
  assert.deepEqual(h.emits, ['done done']);
});

test('the feed reported the finish first: herdr stays quiet', async () => {
  const h = harness(newWatch('settled 5'));
  await h.run([get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12), () => assert.ok(h.feed('Stop')))]);
  assert.deepEqual(h.emits, []);
  assert.equal(h.watch().handled, 'settled 12', 'covered, so a restart does not report it');
});

test('herdr reported first: the late feed line for the same finish is dropped', async () => {
  const h = harness(newWatch('settled 5'));
  let late: boolean | undefined;
  await h.run([
    get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12)),
    get(agent('done', 12, 12), () => { h.flush(); late = h.feed('Stop'); }),
  ]);
  assert.deepEqual(h.emits, ['done done']);
  assert.equal(late, false);
});

test('a second quick turn is not swallowed', async () => {
  const h = await harness(newWatch('settled 5')).run([
    get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12)),
    get(agent('working', 13)), untilWorking(agent('working', 13)), settled(agent('done', 14, 14)),
  ]);
  assert.deepEqual(h.emits, ['done done', 'done done']);
});

test('a turn that ends during the grace is still watched, and its feed line does not hide the one before', async () => {
  const h = harness(newWatch('settled 5'));
  let second: boolean | undefined;
  await h.run([
    get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('done', 12, 12)),
    get(agent('working', 13)), untilWorking(agent('working', 13)),
    settled(agent('done', 14, 14), () => { second = h.feed('Stop'); }),
  ]);
  assert.equal(second, true, 'the feed reports turn two');
  assert.deepEqual(h.emits, ['done done'], 'herdr reports turn one only');
});

test('failed waits retry and look again, so a finish during the failure counts', async () => {
  const h = await harness(newWatch('settled 5')).run([
    get(agent('idle', 5, 5)), untilWorking(err('unparsed')),
    get(agent('working', 11)), untilWorking(agent('working', 11)), settled(err('agent_not_found')),
    get(agent('done', 12, 12)),
  ]);
  assert.deepEqual(h.emits, ['done done']);
  assert.deepEqual(h.sleeps, [5000, 5000]);
});

test('a block, answered, then a finish: two reports, the block once even with a Notification', async () => {
  const h = harness(newWatch('settled 5'));
  await h.run([
    get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('blocked', 12)),
    get(agent('blocked', 12)), untilWorking(agent('working', 13)), settled(agent('done', 14, 14)),
  ]);
  assert.deepEqual(h.emits, ['blocked blocked', 'done done']);
  const n = harness(newWatch('settled 5'));
  await n.run([get(agent('idle', 5, 5)), untilWorking(agent('working', 11)), settled(agent('blocked', 12), () => assert.ok(n.feed('Notification')))]);
  assert.deepEqual(n.emits, []);
});

test('settle keys and segments', () => {
  assert.equal(settleKey({ agent_status: 'done', state_change_seq: 9, completion_seq: 7 }), 'settled 7');
  assert.equal(settleKey({ agent_status: 'idle', state_change_seq: 9 }), 'settled 9');
  assert.equal(settleKey({ agent_status: 'blocked', state_change_seq: 9 }), 'blocked 9');
  assert.equal(settleKey({ agent_status: 'working', state_change_seq: 9 }), null);
  const w = working(newWatch(), { state_change_seq: 3 });
  assert.equal(working(w, { state_change_seq: 3 }).segment, 1, 'the same working state is one segment');
  assert.equal(feedEvent(w, { event: 'UserPromptSubmit' }).w.segment, 2);
  assert.deepEqual(feedEvent(w, { event: 'SessionStart' }), { w, print: true });
  assert.equal(herdrSettled(w, { agent_status: 'working' }, 1).report, null);
});
