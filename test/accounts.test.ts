import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decide, EMPTY, errorLine, GAP_MS, loginLines, loginUrl, parseLogin, parseUsage, pctNow, pollDue, serviceSuffix, statusLines, type Account, type AccountsState, type Usage } from '../src/accounts.ts';

const MIN = 60_000, H = 60 * MIN;
const now = Date.parse('2026-11-25T12:00:00Z');
const A: Account[] = [
  { name: 'inst', orgId: 'o1', orgName: 'Tiki-institut', dir: '/s/inst' },
  { name: 'gmbh', orgId: 'o2', orgName: 'Tiki GmbH', dir: '/s/gmbh' },
];
const u = (five: number, week: number, o: { at?: number; fiveReset?: number; weekReset?: number } = {}): Usage => ({
  fiveHour: { pct: five, resetsAt: o.fiveReset ?? now + 2 * H },
  sevenDay: { pct: week, resetsAt: o.weekReset ?? now + 3 * 24 * H },
  at: o.at ?? now,
});
const st = (usage: Record<string, Usage>, extra: Partial<AccountsState> = {}): AccountsState => ({ ...EMPTY, usage, ...extra });

test('parseUsage reads the endpoint body and refuses a partial one', () => {
  const body = { five_hour: { utilization: 23, resets_at: '2026-11-25T15:19:59.9+00:00' }, seven_day: { utilization: 4.0, resets_at: '2026-11-30T16:59:59+00:00' }, seven_day_opus: null };
  const p = parseUsage(body, now)!;
  assert.equal(p.fiveHour.pct, 23);
  assert.equal(p.sevenDay.resetsAt, Date.parse('2026-11-30T16:59:59Z'));
  assert.equal(p.at, now);
  assert.equal(parseUsage({ five_hour: body.five_hour }, now), undefined);
  assert.equal(parseUsage(null, now), undefined);
});

test('a window whose reset has passed counts as empty', () => {
  assert.equal(pctNow({ pct: 100, resetsAt: now - 1 }, now), 0);
  assert.equal(pctNow({ pct: 100, resetsAt: now + 1 }, now), 100);
});

test('under 95% nothing happens', () => {
  assert.deepEqual(decide(A, 'inst', st({ inst: u(94, 60), gmbh: u(0, 0) }), now), { kind: 'stay' });
});

test('at 95% on the 5h window it switches to the seat with room and says both numbers', () => {
  const v = decide(A, 'inst', st({ inst: u(96, 61), gmbh: u(6, 12) }), now);
  assert.equal(v.kind, 'switch');
  assert.equal(v.kind === 'switch' && v.to, 'gmbh');
  assert.match(v.kind === 'switch' ? v.line : '', /^ACCOUNT switched inst -> gmbh \(inst: 5h 96%, week 61%; gmbh: 5h 6%, week 12%\)$/);
});

test('the weekly window alone triggers it too, in both directions', () => {
  assert.equal(decide(A, 'gmbh', st({ gmbh: u(10, 95), inst: u(20, 30) }), now).kind, 'switch');
});

test('a target at 90% or more on either window is no target', () => {
  const v = decide(A, 'inst', st({ inst: u(97, 50), gmbh: u(5, 90) }), now);
  assert.equal(v.kind, 'full');
  assert.match(v.kind === 'full' ? v.line : '', /^ACCOUNT full: inst: 5h 97%, week 50%; gmbh: 5h 5%, week 90%\. Earliest room: /);
});

test('a target whose full week has reset since orch last read it counts as having room', () => {
  const v = decide(A, 'inst', st({ inst: u(96, 50), gmbh: u(5, 100, { at: now - 5 * 24 * H, weekReset: now - H }) }), now);
  assert.equal(v.kind === 'switch' && v.to, 'gmbh');
});

test('stale active numbers are not acted on', () => {
  assert.equal(decide(A, 'inst', st({ inst: u(99, 99, { at: now - 11 * MIN }), gmbh: u(0, 0) }), now).kind, 'stay');
});

test('a full window that resets within 15 minutes is waited out', () => {
  assert.equal(decide(A, 'inst', st({ inst: u(97, 40, { fiveReset: now + 10 * MIN }), gmbh: u(0, 0) }), now).kind, 'stay');
  // unless the other window is full for longer
  assert.equal(decide(A, 'inst', st({ inst: u(97, 96, { fiveReset: now + 10 * MIN }), gmbh: u(0, 0) }), now).kind, 'switch');
});

test('never two switches within 30 minutes', () => {
  const s = st({ inst: u(96, 10), gmbh: u(0, 0) }, { lastSwitch: now - GAP_MS + MIN });
  assert.equal(decide(A, 'inst', s, now).kind, 'stay');
  assert.equal(decide(A, 'inst', { ...s, lastSwitch: now - GAP_MS }, now).kind, 'switch');
});

test('all full is said once an hour, and a seat without numbers is no target', () => {
  const s = st({ inst: u(99, 50) });
  const v = decide(A, 'inst', s, now);
  assert.equal(v.kind, 'full');
  assert.match(v.kind === 'full' ? v.line : '', /gmbh: no numbers yet/);
  assert.equal(decide(A, 'inst', { ...s, fullSaid: now - 59 * MIN }, now).kind, 'stay');
});

test('picks the target with the most room', () => {
  const three = [...A, { name: 'third', orgId: 'o3', orgName: 'Third', dir: '/s/3' }];
  const v = decide(three, 'inst', st({ inst: u(96, 10), gmbh: u(50, 60), third: u(5, 20) }), now);
  assert.equal(v.kind === 'switch' && v.to, 'third');
});

test('active seat polls every 3 minutes, standby every 15', () => {
  const s = st({ inst: u(0, 0, { at: now - 3 * MIN }), gmbh: u(0, 0, { at: now - 14 * MIN }) });
  assert.equal(pollDue('inst', 'inst', s, now), true);
  assert.equal(pollDue('gmbh', 'inst', s, now), false);
  assert.equal(pollDue('gmbh', 'inst', s, now + MIN), true);
  assert.equal(pollDue('new', 'inst', s, now), true);
});

test('login due 5 days ahead, once a day; expired says so', () => {
  const r = loginLines({ inst: now + 4 * 24 * H, gmbh: now + 20 * 24 * H }, EMPTY, now, '2026-11-25');
  assert.deepEqual(r.lines, ['ACCOUNT login due inst: expires 2026-11-29, run orch account login inst']);
  assert.equal(loginLines({ inst: now + 4 * 24 * H }, { ...EMPTY, loginSaid: r.said }, now, '2026-11-25').lines.length, 0);
  assert.equal(loginLines({ inst: now + 4 * 24 * H }, { ...EMPTY, loginSaid: r.said }, now, '2026-11-26').lines.length, 1);
  assert.match(loginLines({ inst: now - H }, EMPTY, now, '2026-11-25').lines[0], /^ACCOUNT login expired inst/);
  assert.equal(loginLines({ inst: 0 }, EMPTY, now, '2026-11-25').lines.length, 0);
});

test('an error is said once an hour', () => {
  const a = errorLine('boom', EMPTY, now);
  assert.equal(a.line, 'ACCOUNT error: boom');
  assert.equal(errorLine('boom', { ...EMPTY, errorSaid: a.said }, now + 30 * MIN).line, undefined);
  assert.equal(errorLine('boom', { ...EMPTY, errorSaid: a.said }, now + 61 * MIN).line, 'ACCOUNT error: boom');
});

test('status marks the active seat and shows resets and login expiry', () => {
  const lines = statusLines(A, 'gmbh', st({ inst: u(24, 4, { at: now - 2 * MIN }) }), { inst: Date.parse('2026-12-23T03:00:00Z') }, now);
  assert.match(lines[0], /^  inst +5h  24% \(resets \d\d:\d\d\)  week   4% \(resets .+\), read 2 min ago, login until 2026-12-23$/);
  assert.match(lines[1], /^\* gmbh +no numbers yet$/);
});

test('keychain service names match Claude Code: sha256 of the config dir, 8 hex', () => {
  const hex = createHash('sha256').update('/Users/lucas/.orch-accounts/swaptest').digest('hex');
  assert.equal(serviceSuffix(hex), 'Claude Code-credentials-514d5be3'); // the name Claude Code used in the 2026-11-25 test
});

test('parseLogin reads the stored login and rejects junk', () => {
  assert.equal(parseLogin('{"claudeAiOauth":{"accessToken":"t","expiresAt":5,"organizationUuid":"o1"}}')?.organizationUuid, 'o1');
  assert.equal(parseLogin('{}'), undefined);
  assert.equal(parseLogin('not json'), undefined);
  assert.equal(parseLogin(undefined), undefined);
});

test('loginUrl takes the last authorize link a pane printed', () => {
  const out = 'Opening browser…\nIf the browser didn\'t open, visit:\nhttps://claude.ai/oauth/authorize?a=1\nPaste code here if prompted >\nvisit:\nhttps://claude.ai/oauth/authorize?b=2&login_hint=x%40y\n';
  assert.equal(loginUrl(out), 'https://claude.ai/oauth/authorize?b=2&login_hint=x%40y');
  assert.equal(loginUrl('nothing'), undefined);
});
