import { test } from 'node:test';
import assert from 'node:assert/strict';
import { due, nextRun, orchPane, parseRoutine, parseSchedule, renderRoutine, runName } from '../src/routines.ts';

// 2026-10-22 is a Thursday; local time throughout, like launchd.
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);

test('schedules parse, bad ones are rejected', () => {
  assert.deepEqual(parseSchedule('weekdays 08:30'), { kind: 'at', days: [1, 2, 3, 4, 5], times: [[8, 30]] });
  assert.deepEqual(parseSchedule('Mon,Thu 09:00,14:00'), { kind: 'at', days: [1, 4], times: [[9, 0], [14, 0]] });
  assert.deepEqual(parseSchedule('every 2h'), { kind: 'every', ms: 2 * 36e5 });
  assert.deepEqual(parseSchedule('every 30m'), { kind: 'every', ms: 30 * 6e4 });
  for (const bad of ['', 'weekdays', 'someday 08:00', 'daily 25:00', 'every 0m', 'every 2d']) assert.equal(parseSchedule(bad), null, bad);
});

test('a daily slot runs once, after it passes', () => {
  const s = parseSchedule('weekdays 08:30')!;
  assert.equal(due(s, at(22, 8, 0), at(22, 8, 29)), null);
  assert.deepEqual(due(s, at(22, 8, 0), at(22, 8, 31)), { run: at(22, 8, 30) });
  assert.equal(due(s, at(22, 8, 30), at(22, 9, 0)), null, 'already ran this slot');
});

test('a slot missed while asleep runs late once, or is skipped after 12h', () => {
  const s = parseSchedule('weekdays 08:30')!;
  assert.deepEqual(due(s, at(21, 9), at(22, 11)), { run: at(22, 8, 30) });
  // Friday 08:30 missed, Mac wakes Saturday noon: Friday's slot is too stale.
  assert.deepEqual(due(s, at(22, 9), at(24, 12)), { skip: at(23, 8, 30) });
  assert.equal(due(s, at(23, 8, 30), at(25, 12)), null, 'weekend has no slot');
});

test('interval routines run when the interval has passed', () => {
  const s = parseSchedule('every 2h')!;
  assert.equal(due(s, at(22, 8), at(22, 9, 59)), null);
  assert.deepEqual(due(s, at(22, 8), at(22, 10, 1)), { run: at(22, 10, 1) });
});

test('next run is the following slot, skipping days off', () => {
  const s = parseSchedule('weekdays 08:30')!;
  assert.deepEqual(nextRun(s, at(22, 8), at(22, 9)), at(23, 8, 30));
  assert.deepEqual(nextRun(s, at(23, 9), at(23, 9)), at(26, 8, 30));
  assert.deepEqual(nextRun(parseSchedule('every 2h')!, at(22, 8), at(22, 9)), at(22, 10));
});

test('routine files round-trip; mode defaults from the repo', () => {
  const r = parseRoutine(renderRoutine({ name: 'pr-round', schedule: 'weekdays 08:30', mode: 'orch', repo: '', tools: '', paused: false, prompt: 'look at the PRs of tariffs' }), 'pr-round');
  assert.equal(r?.prompt, 'look at the PRs of tariffs');
  assert.equal(r?.mode, 'orch');
  const w = parseRoutine('# deps\nSchedule: mon 09:00\nRepo: tariffs\nStatus: paused\n\nUpdate dependencies.\n\nRun the tests.\n', 'deps');
  assert.equal(w?.mode, 'worker');
  assert.equal(w?.paused, true);
  assert.equal(w?.prompt, 'Update dependencies.\n\nRun the tests.');
  assert.equal(parseRoutine('# x\nSchedule: mon 09:00\nMode: worker\n\nno repo\n', 'x'), null, 'worker needs a repo');
  assert.equal(parseRoutine('# x\nSchedule: whenever\n\nhi\n', 'x'), null);
  assert.equal(parseRoutine('# X\nSchedule: mon 09:00\n\nhi\n', 'Bad Name'), null);
});

test('worker runs get a name per slot, within the 32 character limit', () => {
  const r = parseRoutine('# deps-update-weekly-ab\nSchedule: mon 09:00\nRepo: t\n\ngo\n', 'deps-update-weekly-ab')!;
  const n = runName(r, at(26, 9, 5));
  assert.equal(n, 'deps-update-weekly-ab-1026-0905');
  assert.ok(n.length <= 32);
});

test('orch is the Claude session titled orch in its own folder', () => {
  const live = [
    { pane_id: 'w9:p2', agent_status: 'idle', agent: 'claude', cwd: '/o', terminal_title_stripped: 'fix bug' },
    { pane_id: 'w9:p1', agent_status: 'done', agent: 'claude', cwd: '/o', terminal_title_stripped: 'orch' },
  ];
  assert.equal(orchPane(live, '/o')?.pane_id, 'w9:p1');
  assert.equal(orchPane(live, '/elsewhere'), undefined);
});
