import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failingTests } from '../src/gate-output.ts';

test('names failing node:test tests with their first error line, not their parent suites', () => {
  const out = [
    'TAP version 13',
    '# Subtest: houses',
    '    not ok 1 - a bid hides the wallet',
    '      ---',
    '      duration_ms: 12.3',
    "      failureType: 'testCodeFailure'",
    "      error: 'Expected values to be strictly equal:'",
    '      code: ERR_ASSERTION',
    '      ...',
    '    ok 2 - a bid shows the amount',
    'not ok 1 - houses',
    '  ---',
    "  failureType: 'subtestsFailed'",
    "  error: '1 subtest failed'",
    '  ...',
    'not ok 2 - perf report matches main',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    missing perf report for apps/web',
    '  ...',
    '# fail 2',
  ].join('\n');
  assert.deepEqual(failingTests(out), [
    'a bid hides the wallet: Expected values to be strictly equal:',
    'perf report matches main: missing perf report for apps/web',
  ]);
});

test('names failing vitest tests once, with an error line when it follows', () => {
  const out = [
    ' FAIL  |client| src/client/assets/gamification/traits.test.ts > rollTraits > reaches every trait',
    'Error: Test timed out in 5000ms.',
    ' ❯ src/client/assets/gamification/traits.test.ts:88:3',
    ' × src/client/pages/PulslingPage.test.tsx > equips an item 5012ms',
    ' FAIL  |client| src/client/assets/gamification/traits.test.ts > rollTraits > reaches every trait',
    ' Test Files  1 failed | 140 passed (141)',
  ].join('\n');
  assert.deepEqual(failingTests(out), [
    '|client| src/client/assets/gamification/traits.test.ts > rollTraits > reaches every trait: Error: Test timed out in 5000ms.',
    'src/client/pages/PulslingPage.test.tsx > equips an item',
  ]);
});

test('passing output names nothing', () => {
  assert.deepEqual(failingTests('ok 1 - a\nok 2 - b\n# pass 2\n# fail 0'), []);
});

test('lists at most 20 failures', () => {
  const out = Array.from({ length: 30 }, (_, i) => `not ok ${i + 1} - t${i}`).join('\n');
  assert.equal(failingTests(out).length, 20);
});
