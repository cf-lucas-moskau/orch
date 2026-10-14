import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressTask, renderTriage, triagePr, triagePrs, type Pr } from '../src/prs.ts';

const me = 'me';
const pr = (n: number, author: string, o: Partial<{ draft: boolean; reviews: [string, string, string][]; threads: [boolean, string, string][]; comments: [string, string][]; last: string }> = {}): Pr => ({
  number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, isDraft: o.draft ?? false, headRefName: `feat-${n}`, baseRefName: 'main',
  author: { login: author },
  commits: { nodes: [{ commit: { committedDate: o.last ?? '2026-10-07T10:00:00Z' } }] },
  reviews: { nodes: (o.reviews ?? []).map(([login, state, submittedAt]) => ({ author: { login }, state, submittedAt })) },
  reviewThreads: { nodes: (o.threads ?? []).map(([isResolved, login, body]) => ({ isResolved, comments: { nodes: [{ author: { login }, body, path: 'src/a.ts', line: 12 }] } })) },
  comments: { nodes: (o.comments ?? []).map(([login, createdAt]) => ({ author: { login }, body: 'please also handle the empty case', createdAt })) },
});

test('my PR with an unresolved colleague thread needs addressing; my own and bot threads do not count', () => {
  const t = triagePr(pr(1, me, { threads: [[false, 'KorbinianK', 'rename this'], [false, me, 'note to self'], [false, 'cursor', 'bugbot says'], [true, 'Alex', 'done']] }), me);
  assert.equal(t.kind, 'address');
  assert.deepEqual(t.kind === 'address' && t.feedback.map(f => f.who), ['KorbinianK']);
});

test('colleague conversation comments only count after the last push', () => {
  assert.equal(triagePr(pr(2, me, { comments: [['Alex', '2026-10-07T09:00:00Z']] }), me).kind, 'waiting');
  assert.equal(triagePr(pr(3, me, { comments: [['Alex', '2026-10-07T11:00:00Z']] }), me).kind, 'address');
});

test('my approved PR with nothing open is approved; with no human review it is waiting', () => {
  const a = triagePr(pr(4, me, { reviews: [['KorbinianK', 'APPROVED', '2026-10-07T11:00:00Z'], ['cursor', 'COMMENTED', '2026-10-07T11:00:00Z']] }), me);
  assert.deepEqual(a.kind === 'approved' && a.by, ['KorbinianK']);
  assert.equal(triagePr(pr(5, me, { reviews: [['cursor', 'COMMENTED', '2026-10-07T11:00:00Z']] }), me).kind, 'waiting');
});

test('changes requested after the last push needs addressing even without threads', () => {
  assert.equal(triagePr(pr(6, me, { reviews: [['Alex', 'CHANGES_REQUESTED', '2026-10-07T12:00:00Z']] }), me).kind, 'address');
  assert.equal(triagePr(pr(7, me, { reviews: [['Alex', 'CHANGES_REQUESTED', '2026-10-07T09:00:00Z']] }), me).kind, 'waiting');
});

test("a colleague's PR is up for review until a human other than the author reviewed it", () => {
  assert.equal(triagePr(pr(8, 'Alex', { reviews: [['cursor', 'COMMENTED', 'x'], ['Alex', 'COMMENTED', 'x']] }), me).kind, 'review');
  const r = triagePr(pr(9, 'Alex', { reviews: [[me, 'APPROVED', 'x']] }), me);
  assert.deepEqual(r.kind === 'reviewed' && r.by, [me]);
  assert.equal(triagePr(pr(10, 'Alex', { draft: true }), me).kind, 'draft');
});

test('report groups by what the user has to do, most actionable first', () => {
  const out = renderTriage('tariffs', triagePrs([pr(10, 'Alex', { draft: true }), pr(8, 'Alex'), pr(1, me, { threads: [[false, 'KorbinianK', 'x']] })], me));
  assert.match(out, /## Yours, colleague feedback to check and implement \(1\)\n- #1 PR 1 \(@me · 1 open comments\)\n\n## Colleagues', not reviewed yet \(1\)\n- #8/);
  assert.match(out, /## Drafts \(1\)/);
  assert.match(renderTriage('x', []), /No open PRs\./);
});

test('address brief quotes every comment with its location', () => {
  const p = pr(1, me);
  const out = addressTask(p, [{ who: 'KorbinianK', where: 'src/a.ts:12', body: 'rename this' }]);
  assert.match(out, /PR #1 "PR 1"/);
  assert.match(out, /1\. @KorbinianK on src\/a\.ts:12:\nrename this/);
  assert.match(out, /Do not reply on GitHub/);
});
