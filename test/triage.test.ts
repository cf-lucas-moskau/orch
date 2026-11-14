import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, feedLine, screenTail } from '../src/triage.ts';
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

const workers = [
  { name: 'art-inpaint', pane: 'w7:p1', sid: 'aaaa1111-0000', worktree: '/wt/art-inpaint', status: 'running' },
  { name: 'codex-w', pane: 'w8:p1', worktree: '/wt/codex-w', status: 'running' },
];
const sessions = { 'bbbb2222-0000': { name: 'orch-ui', pane: 'w2:p1' } };
const at = (sid: string, cwd: string, event: string, msg: string): FeedEvent => ({ ts: '', sid, event, cwd, prompt: '', msg });
const line = (e: FeedEvent) => feedLine(e, workers, sessions, new Set(['cccc3333-0000']));

test('a worker is done only when its own session id ends the turn', () => {
  assert.equal(line(at('aaaa1111-0000', '/wt/art-inpaint', 'Stop', 'All gates green.')), 'DONE worker art-inpaint [w7:p1] aaaa1111: All gates green.');
  assert.equal(line(at('dddd4444-0000', '/wt/art-inpaint', 'Stop', '{"doors": 3}')), undefined, 'a critic run in the worktree is not the worker');
  assert.equal(line(at('dddd4444-0000', '/wt/art-inpaint/sub', 'Notification', 'Claude needs your permission to use Bash')), undefined,
    'nothing from another session in the worktree, a prompt included');
  assert.equal(line(at('eeee5555-0000', '/wt/codex-w/app', 'Stop', 'Codex finished.')), 'DONE worker codex-w [w8:p1] eeee5555: Codex finished.',
    'a worker without a session id is found by its worktree');
});

test('a one-off session in a worker worktree says nothing; unknown sessions elsewhere still do', () => {
  assert.equal(line(at('50f10d65-0000', '/wt/art-inpaint', 'Stop', 'ok')), undefined);
  assert.equal(line(at('50f10d65-0000', '/wt/art-inpaint', 'Stop', 'Which file?')), undefined);
  assert.equal(line(at('ffff6666-0000', '/Users/lucas/orch', 'Stop', 'Which file?')), 'QUESTION ffff6666 [?] ffff6666: Which file?');
  assert.equal(line(at('ffff6666-0000', '/Users/lucas/orch', 'Stop', 'Merged.')), 'DONE ffff6666 [?] ffff6666: Merged.');
  assert.equal(line(at('ffff6666-0000', '/Users/lucas/orch', 'Stop', '')), undefined, 'an empty DONE from an unknown helper says nothing');
  assert.equal(line(at('ffff6666-0000', '/wt/art-inpaint-2', 'Stop', 'Merged.')), 'DONE ffff6666 [?] ffff6666: Merged.', 'a sibling folder is not the worktree');
  assert.equal(line(at('bbbb2222-0000', '/r', 'Stop', 'Which file?')), 'QUESTION orch-ui [w2:p1] bbbb2222: Which file?');
  assert.equal(line(at('bbbb2222-0000', '/r', 'Stop', 'Merged.')), 'DONE orch-ui [w2:p1] bbbb2222: Merged.');
  assert.equal(line(at('cccc3333-0000', '/r', 'Stop', 'Merged.')), undefined, 'a lead is never DONE');
});

test('other events are noise', () => {
  assert.equal(classify(ev('SessionStart', '')), 'skip');
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
