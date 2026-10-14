import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeFindings, parseFindings, renderReview, type Finding } from '../src/review.ts';

const f = (file: string, line: number | null, title: string, why = '', severity: Finding['severity'] = 'medium'): Finding =>
  ({ file, line, severity, title, why });

test('findings parse from fenced or chatty output, bad shapes give null', () => {
  const fenced = 'Here you go:\n```json\n{"findings":[{"file":"b/src/a.ts","line":3,"severity":"blocking","title":"Null deref","why":"x"}]}\n```';
  assert.deepEqual(parseFindings(fenced), [f('src/a.ts', 3, 'Null deref', 'x', 'blocking')]);
  assert.deepEqual(parseFindings('{"findings":[]}'), []);
  assert.equal(parseFindings('no json'), null);
  assert.equal(parseFindings('{"items":[]}'), null);
  assert.equal(parseFindings('{"findings":[{"file":"a","line":"x","severity":"huge","title":"t"}]}')![0].severity, 'minor');
});

test('the same bug found by both models is matched once, the rest stay per model', () => {
  const claude = [
    f('src/pay.ts', 40, 'Refund amount not validated', 'negative refund credits the customer'),
    f('src/pay.ts', 90, 'Missing test for currency rounding'),
  ];
  const codex = [
    f('src/pay.ts', 43, 'Negative refund amount accepted', 'refund validation missing, customer credited'),
    f('src/db.ts', 10, 'Transaction not rolled back on error'),
  ];
  const m = mergeFindings(claude, codex);
  assert.equal(m.both.length, 1);
  assert.equal(m.both[0].codex.line, 43);
  assert.deepEqual(m.claudeOnly.map(x => x.line), [90]);
  assert.deepEqual(m.codexOnly.map(x => x.file), ['src/db.ts']);
});

test('nearby lines alone do not merge unrelated findings', () => {
  const m = mergeFindings([f('a.ts', 10, 'SQL injection in search query')], [f('a.ts', 12, 'Timezone dropped from date parsing')]);
  assert.equal(m.both.length, 0);
});

test('report puts agreed findings first, with the stronger severity', () => {
  const out = renderReview({
    repo: 'orch', base: 'main', head: 'abc123', date: '2026-10-06', notes: [],
    m: { both: [{ claude: f('a.ts', 1, 'Leak', 'c', 'minor'), codex: f('a.ts', 2, 'Leak', 'x', 'blocking') }], claudeOnly: [], codexOnly: [f('b.ts', null, 'Race')] },
  });
  assert.match(out, /1 agreed · 0 Claude only · 1 Codex only/);
  assert.match(out, /## Both models\n- \[blocking\] a\.ts:1 Leak\n  Claude: c\n  Codex: x/);
  assert.match(out, /## Codex only[^\n]*\n- \[medium\] b\.ts Race/);
});
