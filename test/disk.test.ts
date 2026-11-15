import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterThin, NEVER, parseDfFreeGb, parseDiskThin, THIN_ARGS, thinDue } from '../src/disk.ts';

const SRC = join(import.meta.dirname, '..', 'src');
const MIN = 60_000;
const T0 = Date.parse('2026-11-15T12:00:00Z');

test('Disk thin comes from local.md, 30 GB without it, and does not read the Disk floor', () => {
  assert.equal(parseDiskThin('Disk floor: 10 GB\nDisk thin: 45 GB\n'), 45);
  assert.equal(parseDiskThin('Disk floor: 10 GB\n'), 30);
  assert.equal(parseDiskThin(''), 30);
});

test('a thin runs under the threshold, at most once per 10 minutes', () => {
  assert.equal(thinDue(NEVER, T0, 29, 30), true);
  assert.equal(thinDue(NEVER, T0, 30, 30), false);
  const s = { ...NEVER, thinned: T0 };
  assert.equal(thinDue(s, T0 + 9 * MIN, 5, 30), false);
  assert.equal(thinDue(s, T0 + 10 * MIN, 5, 30), true);
});

test('a thin that freed space says before and after; one still under 20 GB says DISK low once an hour', () => {
  const first = afterThin(NEVER, T0, 18, 59);
  assert.deepEqual(first.lines, ['DISK thinned local snapshots: 18 -> 59 GB free']);
  assert.deepEqual(first.state, { thinned: T0, lowSaid: 0 });

  const low = afterThin(NEVER, T0, 12, 15);
  assert.deepEqual(low.lines, ['DISK thinned local snapshots: 12 -> 15 GB free', 'DISK low: 15 GB free after thinning']);
  const again = afterThin(low.state, T0 + 59 * MIN, 15, 15);
  assert.deepEqual(again.lines, []);
  assert.equal(again.state.lowSaid, T0);
  assert.deepEqual(afterThin(again.state, T0 + 60 * MIN, 15, 15).lines, ['DISK low: 15 GB free after thinning']);
});

test('the thin command only ever thins the boot volume by amount, never a dated delete or sudo', () => {
  assert.deepEqual(THIN_ARGS, ['thinlocalsnapshots', '/', '999999999999', '4']);
});

test('df -k output parses to whole GB free', () => {
  const out = 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n'
    + '/dev/disk3s5 482797652 385197896 61880440 87% 7500390 618804400 1% /System/Volumes/Data\n';
  assert.equal(parseDfFreeGb(out), 59);
  assert.equal(parseDfFreeGb('df: nope'), undefined);
});

// The watcher end to end, with df and tmutil stubbed on PATH: df reports 18 GB until tmutil ran, then 25 GB, still under the 30 GB default.
const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

function setup(localMd: string) {
  const root = mkdtempSync(join(tmpdir(), 'orch-disk-'));
  for (const d of ['feed', 'leads', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock"}');
  writeFileSync(join(root, 'local.md'), localMd);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const thinned = join(root, 'thinned');
  writeFileSync(join(bin, 'df'), `#!/bin/sh
kb=$((18 * 1048576)); [ -f '${thinned}' ] && kb=$((25 * 1048576))
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/disk3s5 482797652 1 $kb 87% /System/Volumes/Data"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'tmutil'), `#!/bin/sh\necho "$@" >> '${thinned}'\n`, { mode: 0o755 });
  return { root, bin, thinned };
}

async function watch(root: string, bin: string, ms: number) {
  const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(SRC, 'watch.ts')],
    { env: { ...process.env, ORCH_DIR: root, ORCH_SID: 'orch0001', ORCH_QUEUE: 'off', ORCH_DISK_CHECK_MS: '200', PATH: `${bin}:${process.env.PATH}` } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => lines.push(l));
  await new Promise(r => setTimeout(r, ms));
  await new Promise(r => { p.on('exit', r); p.kill(); });
  return lines.filter(l => l.startsWith('DISK'));
}

test('the watcher thins once under the threshold and says it; checks every interval but thins at most once per 10 minutes', async () => {
  const { root, bin, thinned } = setup('Disk floor: 10 GB\n');
  assert.deepEqual(await watch(root, bin, 3000), ['DISK thinned local snapshots: 18 -> 25 GB free']);
  assert.equal(readFileSync(thinned, 'utf8'), 'thinlocalsnapshots / 999999999999 4\n');
  assert.equal(typeof JSON.parse(readFileSync(join(root, 'disk.json'), 'utf8')).thinned, 'number');
});

test('the watcher leaves snapshots alone above the threshold set in local.md', async () => {
  const { root, bin, thinned } = setup('Disk thin: 15 GB\n');
  assert.deepEqual(await watch(root, bin, 2000), []);
  assert.throws(() => readFileSync(thinned, 'utf8'));
});
