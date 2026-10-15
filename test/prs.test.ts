import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressTask, mergeBlocker, renderTriage, triagePr, triagePrs, type Pr, type PrState } from '../src/prs.ts';

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

test('merge waits for green checks, approvals and no conflicts', () => {
  const ok: PrState = { isDraft: false, mergeable: 'MERGEABLE', reviewDecision: '', statusCheckRollup: [
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { context: 'vercel', state: 'SUCCESS' }, { name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' }] };
  assert.equal(mergeBlocker(ok), null);
  assert.equal(mergeBlocker({ ...ok, isDraft: true }), 'draft');
  assert.equal(mergeBlocker({ ...ok, mergeable: 'CONFLICTING' }), 'merge conflicts');
  assert.equal(mergeBlocker({ ...ok, reviewDecision: 'REVIEW_REQUIRED' }), 'a required approval is missing');
  assert.equal(mergeBlocker({ ...ok, reviewDecision: 'CHANGES_REQUESTED' }), 'changes requested');
  assert.equal(mergeBlocker({ ...ok, statusCheckRollup: [{ name: 'test', status: 'IN_PROGRESS', conclusion: null }] }), 'checks pending: test');
  assert.equal(mergeBlocker({ ...ok, statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' }] }), 'checks failed: test');
});

// Case from tariffs #124 on 2026-10-15: I commented, the author pushed fixes, reacted and re-requested me,
// and orch reported "nothing changed". Each of these alone must bring the PR back for a re-review.
test('a colleague PR I reviewed comes back on new commits, re-review request, reaction or reply', () => {
  const reviewed = { reviews: [[me, 'COMMENTED', '2026-10-14T12:26:00Z']] as [string, string, string][], last: '2026-10-14T08:00:00Z' };
  const base = pr(124, 'KorbinianK', reviewed);
  assert.equal(triagePr(base, me).kind, 'reviewed', 'nothing since my review');

  const commits = { ...base, commitsSince: { nodes: [{ commit: { oid: 'a', committedDate: '2026-10-14T13:22:00Z' } }] } };
  const t1 = triagePr(commits, me);
  assert.equal(t1.kind, 'rereview');
  assert.match(t1.kind === 'rereview' ? t1.why.join() : '', /1 new commit/);

  const requested = { ...base, reviewRequests: { nodes: [{ requestedReviewer: { login: me } }] } };
  assert.equal(triagePr(requested, me).kind, 'rereview');

  const reacted = { ...base, reviews: { nodes: [{ ...base.reviews.nodes[0], reactions: { nodes: [{ user: { login: 'KorbinianK' }, content: 'THUMBS_UP', createdAt: '2026-10-15T07:00:00Z' }] } }] } };
  const t3 = triagePr(reacted, me);
  assert.match(t3.kind === 'rereview' ? t3.why.join() : '', /reaction thumbs_up/);

  const replied = pr(124, 'KorbinianK', { ...reviewed, comments: [['KorbinianK', '2026-10-15T07:10:00Z']] });
  assert.equal(triagePr(replied, me).kind, 'rereview');

  const botOnly = pr(124, 'KorbinianK', { ...reviewed, comments: [['cursor', '2026-10-15T07:10:00Z']] });
  assert.equal(triagePr(botOnly, me).kind, 'reviewed', 'bot comments are not a reply');
  assert.equal(triagePrs([base, commits], me)[0].kind, 'rereview', 'rereview sorts before reviewed');
});

test('new commits are counted from the commit my review was on, not by date', () => {
  const skewed = { ...pr(121, 'KorbinianK', { reviews: [[me, 'APPROVED', '2026-10-14T08:02:52Z']] }),
    commitsSince: { nodes: [{ commit: { oid: 'old', committedDate: '2026-10-14T07:00:00Z' } }, { commit: { oid: 'e4eb', committedDate: '2026-10-14T08:06:00Z' } }] } };
  skewed.reviews.nodes[0].commit = { oid: 'e4eb' };
  assert.equal(triagePr(skewed, me).kind, 'reviewed', 'approved head committed 4 min "later" by skew is not new');
  const later = { ...skewed, commitsSince: { nodes: [...skewed.commitsSince.nodes, { commit: { oid: 'fix', committedDate: '2026-10-14T07:47:00Z' } }] } };
  assert.equal(triagePr(later, me).kind, 'rereview', 'a commit after the reviewed one counts even with an earlier date');
});
