import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cloneFromMain } from '../src/disk-io.ts';
import { afterThin, installMatches, NEVER, parseDfFreeGb, parseDiskThin, parseSwapGb, renderDisk, sizeLines, snapshotCount, staleSaved, THIN_ARGS, thinDue } from '../src/disk.ts';

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

test('a thin that freed space says before and after; one still under the Disk floor says DISK low once an hour', () => {
  const first = afterThin(NEVER, T0, 18, 59, 20);
  assert.deepEqual(first.lines, ['DISK thinned local snapshots: 18 -> 59 GB free']);
  assert.deepEqual(first.state, { thinned: T0, lowSaid: 0 });

  const low = afterThin(NEVER, T0, 12, 15, 20);
  assert.deepEqual(low.lines, ['DISK thinned local snapshots: 12 -> 15 GB free', 'DISK low: 15 GB free after thinning']);
  const again = afterThin(low.state, T0 + 59 * MIN, 15, 15, 20);
  assert.deepEqual(again.lines, []);
  assert.equal(again.state.lowSaid, T0);
  assert.deepEqual(afterThin(again.state, T0 + 60 * MIN, 15, 15, 20).lines, ['DISK low: 15 GB free after thinning']);
});

test('DISK low follows the configured Disk floor, not a fixed 20 GB', () => {
  assert.deepEqual(afterThin(NEVER, T0, 12, 15, 10).lines, ['DISK thinned local snapshots: 12 -> 15 GB free']);
  assert.deepEqual(afterThin(NEVER, T0, 22, 22, 25).lines, ['DISK low: 22 GB free after thinning']);
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

function setup(localMd: string, tmutil = `#!/bin/sh\necho "$@" >> "$(dirname "$0")/../thinned"\n`, freeGb = 18) {
  const root = mkdtempSync(join(tmpdir(), 'orch-disk-'));
  for (const d of ['feed', 'leads', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  writeFileSync(join(root, 'ideas', 'config.json'), '{"adapter":"mock"}');
  writeFileSync(join(root, 'local.md'), localMd);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const thinned = join(root, 'thinned');
  writeFileSync(join(bin, 'df'), `#!/bin/sh
kb=$((${freeGb} * 1048576)); [ -f '${thinned}' ] && kb=$((25 * 1048576))
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/disk3s5 482797652 1 $kb 87% /System/Volumes/Data"
`, { mode: 0o755 });
  writeFileSync(join(bin, 'tmutil'), tmutil, { mode: 0o755 });
  // Swap and sizes stubbed too, so the size lines depend on the test, not on this Mac: 1 GB swap, every path 0 KB.
  writeFileSync(join(bin, 'sysctl'), `#!/bin/sh\necho "vm.swapusage: total = 10240.00M  used = $(cat '${root}/swap-mb' 2>/dev/null || echo 1024)M  free = 1.00M  (encrypted)"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'du'), `#!/bin/sh\nkb=$(grep -F "$2=" '${root}/du-kb' 2>/dev/null | head -1 | cut -d= -f2)\nprintf '%s\\t%s\\n' "\${kb:-0}" "$2"\n`, { mode: 0o755 });
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

test('a failing tmutil is reported once and still warns DISK low under the Disk floor from local.md', async () => {
  const { root, bin } = setup('Disk floor: 25 GB\n', '#!/bin/sh\necho "boom" >&2\nexit 1\n', 22);
  assert.deepEqual(await watch(root, bin, 3000), ['DISK error: tmutil thinlocalsnapshots exited 1: boom', 'DISK low: 22 GB free after thinning']);
});

test('the watcher leaves snapshots alone above the threshold set in local.md', async () => {
  const { root, bin, thinned } = setup('Disk thin: 15 GB\n');
  assert.deepEqual(await watch(root, bin, 2000), []);
  assert.throws(() => readFileSync(thinned, 'utf8'));
});

test('the watcher says a worktree past 1.5 GB of its own once, clones left out, and swap past 8 GB once an hour', async () => {
  const { root, bin } = setup('Disk thin: 15 GB\n');
  const big = join(root, 'wt', 'big'), small = join(root, 'wt', 'small'), clonedBig = join(root, 'wt', 'cloned');
  for (const d of [big, small, clonedBig]) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([
    { name: 'big', status: 'running', worktree: big },
    { name: 'small', status: 'running', worktree: small },
    { name: 'cloned', status: 'running', worktree: clonedBig, cloned: ['node_modules'] },
    { name: 'gone', status: 'closed', worktree: big },
  ]));
  writeFileSync(join(root, 'du-kb'), [`${big}=${2 * 1048576}`, `${small}=${1.4 * 1048576}`,
    `${clonedBig}=${2.5 * 1048576}`, `${clonedBig}/node_modules=${1048576}`].join('\n'));
  writeFileSync(join(root, 'swap-mb'), '9216');
  assert.deepEqual(await watch(root, bin, 2000), ['DISK worktree big 2.0 GB', 'DISK swap 9.0 GB']);
  const state = JSON.parse(readFileSync(join(root, 'disk.json'), 'utf8'));
  assert.deepEqual(state.bigSaid, ['big']);
  assert.deepEqual(await watch(root, bin, 1500), [], 'a re-armed watcher does not repeat either line');
});

test('sizeLines: once per running worker name, again for a new worker of that name; swap hourly', () => {
  const GB = 1048576;
  const first = sizeLines({}, T0, [{ name: 'a', kb: 1.6 * GB }, { name: 'b', kb: 1.5 * GB }], 8.5);
  assert.deepEqual(first.lines, ['DISK worktree a 1.6 GB', 'DISK swap 8.5 GB']);
  assert.deepEqual(first.state, { bigSaid: ['a'], swapSaid: T0 });
  assert.deepEqual(sizeLines(first.state, T0 + 59 * MIN, [{ name: 'a', kb: 3 * GB }], 9).lines, []);
  assert.deepEqual(sizeLines(first.state, T0 + 60 * MIN, [{ name: 'a', kb: 3 * GB }], 9).lines, ['DISK swap 9.0 GB']);
  const gone = sizeLines(first.state, T0 + MIN, [], 1);
  assert.deepEqual(gone.state.bigSaid, []);
  assert.deepEqual(sizeLines(gone.state, T0 + 2 * MIN, [{ name: 'a', kb: 2 * GB }], 1).lines, ['DISK worktree a 2.0 GB']);
  assert.deepEqual(sizeLines({}, T0, [], 8).lines, [], '8 GB is not past 8 GB');
  assert.deepEqual(sizeLines({}, T0, [], undefined).lines, []);
});

test('cloneFromMain clones listed folders from the main checkout; node_modules only on the same lockfile, installed as locked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-clone-'));
  const main = join(dir, 'main'), same = join(dir, 'same'), other = join(dir, 'other'), stale = join(dir, 'stale');
  for (const d of [join(main, 'node_modules', 'pkg'), join(main, 'apps', 'web', '.old-mirror'), same, other, stale]) mkdirSync(d, { recursive: true });
  writeFileSync(join(main, 'node_modules', 'pkg', 'index.js'), 'ok');
  symlinkSync('pkg', join(main, 'node_modules', 'alias'));
  writeFileSync(join(main, 'apps', 'web', '.old-mirror', 'a.png'), 'png');
  const lock = (pkgs: object) => JSON.stringify({ packages: { '': {}, ...pkgs } });
  const v1 = lock({ 'node_modules/pkg': { version: '1.0.0' } });
  writeFileSync(join(main, 'package-lock.json'), v1);
  writeFileSync(join(main, 'node_modules', '.package-lock.json'), lock({ 'node_modules/pkg': { version: '1.0.0' } }));
  writeFileSync(join(same, 'package-lock.json'), v1);
  writeFileSync(join(other, 'package-lock.json'), lock({ 'node_modules/pkg': { version: '2.0.0' } }));
  const list = ['node_modules', 'apps/web/.old-mirror', 'missing'];

  assert.deepEqual(cloneFromMain(main, same, list), { done: ['node_modules', 'apps/web/.old-mirror'], failed: [], skipped: [{ path: 'missing', why: 'not in the main checkout' }] });
  assert.equal(readFileSync(join(same, 'node_modules', 'alias', 'index.js'), 'utf8'), 'ok', 'symlinks stay links into the clone');
  assert.equal(readlinkSync(join(same, 'node_modules', 'alias')), 'pkg');
  assert.equal(readFileSync(join(same, 'apps', 'web', '.old-mirror', 'a.png'), 'utf8'), 'png');

  assert.deepEqual(cloneFromMain(main, other, list), { done: ['apps/web/.old-mirror'], failed: [],
    skipped: [{ path: 'node_modules', why: 'package-lock.json differs from the main checkout' }, { path: 'missing', why: 'not in the main checkout' }] });
  assert.throws(() => readFileSync(join(other, 'node_modules', 'pkg', 'index.js')));

  writeFileSync(join(main, 'node_modules', '.package-lock.json'), lock({}));
  writeFileSync(join(stale, 'package-lock.json'), v1);
  assert.deepEqual(cloneFromMain(main, stale, ['node_modules']), { done: [], failed: [],
    skipped: [{ path: 'node_modules', why: 'the main checkout\'s node_modules does not match its package-lock.json' }] });

  writeFileSync(join(main, 'apps', 'web', '.old-mirror', 'a.png'), 'changed');
  assert.deepEqual(cloneFromMain(main, same, list).skipped[1], { path: 'apps/web/.old-mirror', why: 'already in the worktree' });
  assert.equal(readFileSync(join(same, 'apps', 'web', '.old-mirror', 'a.png'), 'utf8'), 'png');
});

test('a nested node_modules with its own lockfile is checked against that lockfile and its own install', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-clone-'));
  const main = join(dir, 'main'), wt = join(dir, 'wt');
  const lock = (v: string) => JSON.stringify({ packages: { '': {}, 'node_modules/x': { version: v } } });
  for (const d of [join(main, 'node_modules', 'x'), join(main, 'apps', 'web', 'node_modules', 'x'), join(wt, 'apps', 'web')]) mkdirSync(d, { recursive: true });
  for (const r of [main, wt]) writeFileSync(join(r, 'package-lock.json'), lock('1.0.0'));
  writeFileSync(join(main, 'node_modules', '.package-lock.json'), lock('1.0.0'));
  writeFileSync(join(main, 'apps', 'web', 'package-lock.json'), lock('2.0.0'));
  writeFileSync(join(main, 'apps', 'web', 'node_modules', '.package-lock.json'), lock('2.0.0'));
  writeFileSync(join(wt, 'apps', 'web', 'package-lock.json'), lock('3.0.0'));
  assert.deepEqual(cloneFromMain(main, wt, ['node_modules', 'apps/web/node_modules']), { done: ['node_modules'], failed: [],
    skipped: [{ path: 'apps/web/node_modules', why: 'apps/web/package-lock.json differs from the main checkout' }] });

  writeFileSync(join(wt, 'apps', 'web', 'package-lock.json'), lock('2.0.0'));
  assert.deepEqual(cloneFromMain(main, wt, ['apps/web/node_modules']).done, ['apps/web/node_modules'], 'same nested lockfile, matching nested install');
});

test('a clone destination must resolve inside the worktree: no .., no absolute path, no symlink out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-clone-'));
  const main = join(dir, 'main'), wt = join(dir, 'wt'), outside = join(dir, 'outside');
  for (const d of [join(main, 'link', 'x'), join(main, 'deep', 'a', 'b'), join(dir, 'escape'), wt, outside]) mkdirSync(d, { recursive: true });
  symlinkSync(outside, join(wt, 'link'));
  symlinkSync(outside, join(wt, 'deep'));
  const r = cloneFromMain(main, wt, ['../escape', '/etc', 'link/x', 'deep/a/b', 'apps/../../escape']);
  assert.deepEqual(r, { done: [], failed: [], skipped: [
    { path: '../escape', why: 'not a path inside the repo' },
    { path: '/etc', why: 'not a path inside the repo' },
    { path: 'link/x', why: 'its folder leads out of the worktree' },
    { path: 'deep/a/b', why: 'its folder leads out of the worktree' },
    { path: 'apps/../../escape', why: 'not a path inside the repo' },
  ] });
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the links');
});

test('an install matches its lockfile when every locked package is there at its version and nothing else is', () => {
  const lock = { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/@rollup/linux': { version: '4.0.0', optional: true },
    'apps/web/node_modules/b': { version: '2.0.0' }, 'node_modules/@evr/core': {} };
  const installed = { 'node_modules/a': { version: '1.0.0' }, 'apps/web/node_modules/b': { version: '2.0.0' }, 'node_modules/@evr/core': {} };
  assert.equal(installMatches(lock, installed), true, 'a skipped optional package and a workspace link are fine');
  assert.equal(installMatches(lock, { ...installed, 'node_modules/a': { version: '0.9.0' } }), false);
  const { 'node_modules/a': _, ...missing } = installed;
  assert.equal(installMatches(lock, missing), false, 'happy-dom missing from main on 2026-11-19');
  assert.equal(installMatches(lock, { ...installed, 'node_modules/extra': { version: '1.0.0' } }), false);
});

test('swap, snapshots and saved/ ages parse from the real tools\' output', () => {
  assert.equal(parseSwapGb('vm.swapusage: total = 10240.00M  used = 9363.94M  free = 876.06M  (encrypted)')?.toFixed(2), '9.14');
  assert.equal(parseSwapGb('vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M'), 0);
  assert.equal(parseSwapGb('nope'), undefined);
  assert.equal(snapshotCount('Snapshots for volume group containing disk /:\ncom.apple.TimeMachine.2026-11-19-160000.local\ncom.apple.os.update-ABC\n'), 2);
  assert.equal(snapshotCount('Snapshots for volume group containing disk /:\n'), 0);
  const now = new Date(2026, 10, 19, 12, 0).getTime();
  const es = [
    { name: 'weaver-polish-20261119-1251', mtimeMs: 0 },
    { name: 'anim-flake-20261116-1159', mtimeMs: now },
    { name: 'art-critic-20261116-1201', mtimeMs: 0 },
    { name: 'hand-made', mtimeMs: now - 4 * 86_400_000 },
    { name: 'fresh-hand-made', mtimeMs: now - 86_400_000 },
  ];
  assert.deepEqual(staleSaved(es, now), ['anim-flake-20261116-1159', 'hand-made'], 'the name\'s stamp wins over mtime; 3 days to the minute');
});

test('orch disk renders free, swap, snapshots, worktrees, saved/, Docker.raw and the top 5', () => {
  const GB = 1048576;
  assert.equal(renderDisk({
    freeGb: 15, swapGb: 9.14, snapshots: 3,
    worktrees: [{ name: 'small', repo: 'orch', kb: 0.1 * GB }, { name: 'big', repo: 'evrloot-next', kb: 1.5 * GB }],
    saved: { kb: 7.5 * GB, folders: 140, stale: 56 }, dockerKb: 25.4 * GB, scratchKb: 0.2 * GB,
  }), [
    'free 15 GB, swap 9.1 GB used, 3 local snapshots',
    '',
    'running worktrees (own bytes, clones left out):',
    '   1.5 GB  big (evrloot-next)',
    '   0.1 GB  small (orch)',
    '',
    '   7.5 GB  saved/, 140 folders, 56 older than 3 days (orch saved --prune)',
    '  25.4 GB  Docker.raw',
    '',
    'top 5:',
    '  25.4 GB  Docker.raw',
    '   9.1 GB  swap',
    '   7.5 GB  saved/',
    '   1.5 GB  worktree big',
    '   0.2 GB  Claude scratch (/private/tmp/claude-*)',
  ].join('\n'));
  assert.match(renderDisk({ snapshots: 1, worktrees: [], saved: { kb: 0, folders: 0, stale: 0 } }), /^free \? GB, swap \? GB used, 1 local snapshot\n[\s\S]*  none\n[\s\S]*Docker\.raw not found/);
});
