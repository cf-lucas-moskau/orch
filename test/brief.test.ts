import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildBrief, parseDecision, parseLearned } from '../src/brief.ts';
import { extractSignals, parseOutcome } from '../src/reflect.ts';
import { parsePlan } from '../src/plan.ts';

const decision = `# D-07: Push the fix?

- Session: tariffs fix (tariffs, w4:p5)
- Opened: 2026-10-05 17:22
- Status: open
- Stakes: push to master
- Gates: npm test green

## Options
1. Push

## Recommendation
Push.

## Outcome
`;

test('decision header and fields parse', () => {
  assert.deepEqual(parseDecision(decision), { id: 'D-07', question: 'Push the fix?', session: 'tariffs fix (tariffs, w4:p5)', status: 'open' });
  assert.equal(parseOutcome(decision), null);
  const done = parseOutcome(decision.replace('Status: open', 'Status: accepted') + '"yes push" 2026-10-05, relayed\n');
  assert.equal(done?.status, 'accepted');
  assert.match(done!.outcome, /yes push/);
});

const learned = `# learned 2026-10-05

## L-1: Squash before presenting
- Category: memory
- Target: ~/.claude/CLAUDE.md
- Change: add a line
- Source: a.jsonl:12 "squash it"
- State: proposed

## L-2: PR merges stay needs the user
- Category: policy
- State: rejected
`;

test('learned items parse with state', () => {
  assert.deepEqual(parseLearned(learned).map(l => [l.id, l.category, l.state]), [['L-1', 'memory', 'proposed'], ['L-2', 'policy', 'rejected']]);
});

test('brief lists open decisions, overnight stops, plans and pending learned items', () => {
  const out = buildBrief({
    date: '2026-10-06', since: '2026-10-05T18:00:00Z',
    feed: [
      { ts: '2026-10-05T17:00:00Z', sid: 'a', event: 'Stop', cwd: '', prompt: '', msg: 'old news' },
      { ts: '2026-10-05T23:00:00Z', sid: 'a', event: 'Stop', cwd: '', prompt: '', msg: 'migrated the parser' },
    ],
    names: { a: { name: 'parser' } },
    decisions: [parseDecision(decision)],
    plans: [parsePlan('# orch\nMilestone: step 3\n- [ ] a: x\n- [x] b: y\n')],
    learned: parseLearned(learned), workers: [],
  });
  assert.match(out, /D-07 Push the fix\?/);
  assert.match(out, /parser: migrated the parser/);
  assert.doesNotMatch(out, /old news/);
  assert.match(out, /orch: step 3\. 1 open, 0 running, 0 blocked, 1 done/);
  assert.match(out, /Learned to review \(1\)\nL-1 \[memory\]/);
});

test('signals keep corrections from the user with the assistant line before them', () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'I committed each unit separately.' }] } },
    { type: 'user', origin: { kind: 'human' }, message: { content: "No, don't commit per unit, squash it." } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'no such file' }] } },
    { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'never mind' } },
    { type: 'user', message: { content: '<command-name>/clear</command-name> stop' } },
    { type: 'user', origin: { kind: 'human' }, message: { content: 'looks good' } },
  ].map(o => JSON.stringify(o)).join('\n');
  const s = extractSignals(lines, 'x.jsonl');
  assert.equal(s.length, 1);
  assert.equal(s[0].cite, 'x.jsonl:2');
  assert.match(s[0].before, /separately/);
});

test('signals skip claude -p sessions and text orch typed itself', () => {
  const lines = [
    { type: 'user', entrypoint: 'sdk-cli', message: { content: 'no, answer yes or no' } },
    { type: 'user', entrypoint: 'cli', message: { content: 'You are worker fix, dispatched by orch. Never push.' } },
    { type: 'user', entrypoint: 'cli', message: { content: 'Task: never push, stop after tests' } },
    { type: 'user', entrypoint: 'cli', message: { content: "don't use em dashes" } },
  ].map(o => JSON.stringify(o)).join('\n');
  assert.deepEqual(extractSignals(lines, 'x', ['Task: never push']).map(s => s.cite), ['x:4']);
});
