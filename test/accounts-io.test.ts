// The swap against the real macOS keychain, on throwaway items that are deleted afterwards. ORCH_LIVE_SERVICE points
// the "live" login at a test item, so the real one is never read or written.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const tag = randomUUID().slice(0, 8);
process.env.ORCH_LIVE_SERVICE = `orch-test-live-${tag}`;
const io = await import('../src/accounts-io.ts');
const { readItem, writeItem, serviceFor, swap } = io;

const H = 3600_000, now = Date.now();
const login = (org: string, tok: string, exp = now + 8 * H) => JSON.stringify({ claudeAiOauth: { accessToken: tok, refreshToken: `r-${tok}`, expiresAt: exp, refreshTokenExpiresAt: now + 20 * 24 * H, organizationUuid: org } });
const A = { name: 'inst', orgId: 'org-a', orgName: 'A', dir: `/tmp/orch-test-${tag}/a` };
const B = { name: 'gmbh', orgId: 'org-b', orgName: 'B', dir: `/tmp/orch-test-${tag}/b` };
const LIVE = process.env.ORCH_LIVE_SERVICE!;
const items = [LIVE, serviceFor(A.dir), serviceFor(B.dir)];
const user = process.env.USER!;
after(() => { for (const s of items) spawnSync('security', ['delete-generic-password', '-a', user, '-s', s]); });

const reset = (live: string, storeB: string) => {
  assert.ok(writeItem(LIVE, live));
  assert.ok(writeItem(serviceFor(A.dir), login('org-a', 'old-a')));
  assert.ok(writeItem(serviceFor(B.dir), storeB));
};

test('writeItem round-trips a value with quotes and spaces through the keychain', () => {
  const v = '{"a": "b c", "d": "it\'s"}';
  assert.ok(writeItem(LIVE, v));
  assert.equal(readItem(LIVE), v);
});

test('swap saves the live login to the active store, loads the target, and keeps it when it checks out', async () => {
  reset(login('org-a', 'live-a'), login('org-b', 'store-b'));
  assert.equal(await swap(A, B, now, async () => 'org-b', false), undefined);
  assert.equal(readItem(LIVE), login('org-b', 'store-b'));
  assert.equal(readItem(serviceFor(A.dir)), login('org-a', 'live-a')); // the rotated live token, not the old store
  // and back the other way
  assert.equal(await swap(B, A, now, async () => 'org-a', false), undefined);
  assert.equal(readItem(LIVE), login('org-a', 'live-a'));
});

test('swap rolls back when claude does not report the target afterwards', async () => {
  reset(login('org-a', 'live-a'), login('org-b', 'store-b'));
  const err = await swap(A, B, now, async () => 'org-a', false);
  assert.match(err!, /rolled back to inst/);
  assert.equal(readItem(LIVE), login('org-a', 'live-a'));
});

test('swap refuses, changing nothing, when the live token is about to refresh', async () => {
  reset(login('org-a', 'live-a', now + 2 * 60_000), login('org-b', 'store-b'));
  assert.match((await swap(A, B, now, async () => 'org-b', false))!, /about to be refreshed/);
  assert.equal(readItem(LIVE), login('org-a', 'live-a', now + 2 * 60_000));
  assert.equal(readItem(serviceFor(A.dir)), login('org-a', 'old-a'));
});

test('swap refuses when the live login is not the seat it switches from, or the target store is wrong', async () => {
  reset(login('org-b', 'live-b'), login('org-b', 'store-b'));
  assert.match((await swap(A, B, now, async () => 'org-b', false))!, /not inst/);
  reset(login('org-a', 'live-a'), login('org-x', 'store-x'));
  assert.match((await swap(A, B, now, async () => 'org-b', false))!, /another organization/);
  assert.equal(readItem(LIVE), login('org-a', 'live-a'));
});
