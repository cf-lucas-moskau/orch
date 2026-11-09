import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, herdrReport, markFeed, screenTail, type Seen } from '../src/triage.ts';
import type { FeedEvent } from '../src/board.ts';

const ev = (event: string, msg: string, tail?: string): FeedEvent => ({ ts: '', sid: 's', event, cwd: '', prompt: '', msg, tail });

test('permission prompts block, idle pings are noise', () => {
  assert.equal(classify(ev('Notification', 'Claude needs your permission to use Bash')), 'blocked');
  assert.equal(classify(ev('Notification', 'Claude is waiting for your input')), 'skip');
});

test('a question at the end of a long message is found through tail', () => {
  assert.equal(classify(ev('Stop', 'All three branches are merged...', '...rows D70-D76. Should I push all three?')), 'question');
  assert.equal(classify(ev('Stop', 'Done. Want me to open the PR')), 'question');
});

test('interim progress after a subagent message is skipped', () => {
  assert.equal(classify(ev('Stop', 'Simplicity lens finished. Four reviewers are still running.')), 'skip');
  assert.equal(classify(ev('Stop', 'Patterns lens is in with minors only. Waiting on correctness.')), 'skip');
});

test('progress with no question is skipped even without a subagent prompt', () => {
  assert.equal(classify(ev('Stop', 'Design gate recorded. Still waiting on the two re-reviewers before pushing.')), 'skip');
});

test('a final report after a subagent message is done', () => {
  assert.equal(classify(ev('Stop', 'I ran five fresh reviewers on PR 113. Five findings need fixing.')), 'done');
});

test('other events are noise', () => {
  assert.equal(classify(ev('SessionStart', '')), 'skip');
});

test('herdr reports a worker settling only when the feed said nothing', () => {
  const seen: Seen = new Map();
  assert.equal(herdrReport(seen, 'worker a', 'done', 1000), 'done', 'hooks missed it: herdr reports');
  assert.equal(herdrReport(seen, 'worker a', 'done', 2000), null, 'once per transition');
  assert.equal(herdrReport(seen, 'worker a', 'idle', 40_000), 'done', 'idle after the window is a new finish');
  assert.equal(herdrReport(seen, 'worker a', 'working', 90_000), null);
  assert.equal(herdrReport(seen, 'worker a', 'unknown', 90_000), null);

  markFeed(seen, 'worker b', { event: 'Stop' }, 100_000);
  assert.equal(herdrReport(seen, 'worker b', 'done', 105_000), null, 'the feed reported it, interim stops and questions included');
  assert.equal(herdrReport(seen, 'worker b', 'blocked', 106_000), 'blocked', 'a Stop says nothing about a block');
  markFeed(seen, 'worker b', { event: 'Notification' }, 200_000);
  assert.equal(herdrReport(seen, 'worker b', 'blocked', 201_000), null);
  markFeed(seen, 'worker b', { event: 'UserPromptSubmit' }, 300_000);
  assert.equal(herdrReport(seen, 'worker b', 'done', 301_000), 'done');
});

test('screenTail keeps the last words and drops the input box and status bar', () => {
  const done = '\n\n❯ Reply with exactly PONG6.\n⏺ PONG6\n✻ Worked for 2s\n──────────\n❯ \n──────────\n  Haiku 5.5 | $0.02\n  ⏵⏵ auto mode on';
  assert.equal(screenTail(done), '❯ Reply with exactly PONG6. ⏺ PONG6 ✻ Worked for 2s');
  const asking = ' ☐ Drink\nDo you prefer tea or coffee?\n❯ 1. Coffee\n  2. Tea\n──────────\nEnter to select · Esc to cancel';
  assert.equal(screenTail(asking), '☐ Drink Do you prefer tea or coffee? ❯ 1. Coffee 2. Tea Enter to select · Esc to cancel', 'a dialog has no empty box');
  assert.equal(screenTail('x'.repeat(300)), 'x'.repeat(200));
});

test('"reviewer is now checking" is progress', () => {
  assert.equal(classify(ev('Stop', 'Merge is committed. A fresh reviewer is now checking the merge commit.')), 'skip');
});
