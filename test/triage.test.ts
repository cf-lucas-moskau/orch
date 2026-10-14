import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/triage.ts';
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

test('"reviewer is now checking" is progress', () => {
  assert.equal(classify(ev('Stop', 'Merge is committed. A fresh reviewer is now checking the merge commit.')), 'skip');
});
