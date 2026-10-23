import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dirname, '..', 'scripts', 'disk-hygiene.sh');
const old = (p: string, days: number) => { const t = new Date(Date.now() - days * 864e5); utimesSync(p, t, t); };
const file = (p: string, days: number, bytes = 1024) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x'.repeat(bytes)); old(p, days); };

// A fake orch root, home and Claude tmp with Docker down; ages set by mtime.
// Docker up: 7.5 GB build cache, an old unused image, a used one, and three compose stacks:
// orch-old, pulse-old and pulsedevwk stopped for 30 days, orch-new stopped yesterday, tiki-old (not a worker's) stopped for 30 days.
const DOCKER_UP = `#!/bin/bash
echo "$*" >> "$(dirname "$0")/calls"
d() { date -u -v-"$1"d +%Y-%m-%dT%H:%M:%S.000000000Z; }
case "$*" in
  info) ;;
  "system df --format"*) printf 'Images 3GB\\nBuild Cache 7.5GB\\n' ;;
  "system df -v") printf 'Images space usage:\\n\\nREPOSITORY TAG\\n\\nLocal Volumes space usage:\\n\\nVOLUME NAME LINKS SIZE\\norch-old_pg 0 2GB\\npulse-old_pg 0 1GB\\ntiki-old_pg 0 9GB\\n\\nBuild cache usage: 7.5GB\\n' ;;
  "ps -aq") printf 'c1\\nc2\\nc3\\n' ;;
  "ps -aq --filter label=com.docker.compose.project=orch-old") echo c1 ;;
  "ps -aq --filter label=com.docker.compose.project=orch-new") echo c2 ;;
  "ps -aq --filter label=com.docker.compose.project=pulse-old") echo c1 ;;
  "ps -aq --filter label=com.docker.compose.project=pulsedevwk") echo c1 ;;
  "inspect --format {{.Image}} c1 c2 c3") printf 'sha256:used\\nsha256:used\\nsha256:used\\n' ;;
  "image ls -aq --no-trunc") printf 'sha256:used\\nsha256:old\\nsha256:fresh\\n' ;;
  "image inspect --format"*) echo "sha256:used $(d 30) 1073741824"; echo "sha256:old $(d 30) 2147483648"; echo "sha256:fresh $(d 1) 1073741824" ;;
  "compose ls -a --format json") echo '[{"Name":"orch-old"},{"Name":"orch-new"},{"Name":"pulse-old"},{"Name":"pulsedevwk"},{"Name":"tiki-old"}]' ;;
  *"State.Running"*c1) echo "false $(d 30)" ;;
  *"State.Running"*c2) echo "false $(d 1)" ;;
  "volume ls -q --filter label=com.docker.compose.project=orch-old") echo orch-old_pg ;;
  "volume ls -q --filter label=com.docker.compose.project=pulse-old") echo pulse-old_pg ;;
  "volume ls -q --filter label=com.docker.compose.project=pulsedevwk") ;;
  "builder prune"*) printf 'Build Cache 5GB\\n' > /dev/null ;;
  "image prune"*) echo "Total reclaimed space: 2GB" ;;
  "compose -p orch-old down -v"|"compose -p pulse-old down -v"|"compose -p pulsedevwk down -v") ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
`;

function world() {
  const base = mkdtempSync(join(tmpdir(), 'disk-hygiene-'));
  const root = join(base, 'orch'), home = join(base, 'home'), tmp = join(base, 'claude-tmp'), bin = join(base, 'bin');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(script, join(root, 'scripts', 'disk-hygiene.sh'));
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', { mode: 0o755 });
  const wt = join(base, 'worktrees', 'orch-busy');
  writeFileSync(join(root, 'workers.json'), JSON.stringify([
    { name: 'busy', worktree: wt, status: 'running' }, { name: 'gone', worktree: join(base, 'worktrees', 'orch-gone'), status: 'closed' }]));
  const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-');
  const paths = {
    staleNm: join(home, 'code', 'stale', 'node_modules', 'big.js'),
    freshNm: join(home, 'code', 'fresh', 'node_modules', 'big.js'),
    busyNm: join(home, 'code', 'busy', 'node_modules', 'big.js'),
    oldScratch: join(tmp, enc(join(base, 'worktrees', 'orch-gone')), 'out.txt'),
    newScratch: join(tmp, '-Users-x-today', 'out.txt'),
    orchScratch: join(tmp, enc(root), 'out.txt'),
    workerScratch: join(tmp, enc(wt), 'out.txt'),
    shipIt: join(home, 'Library', 'Caches', 'com.example.ShipIt', 'update.zip'),
    movies: join(home, 'Movies', 'old.mov'),
  };
  file(paths.staleNm, 200, 200_000);
  file(join(home, 'code', 'stale', 'package.json'), 200);
  old(join(home, 'code', 'stale'), 200);
  file(paths.busyNm, 200);
  file(join(home, 'code', 'busy', 'package.json'), 200);
  old(join(home, 'code', 'busy'), 200);
  file(paths.freshNm, 200);
  file(join(home, 'code', 'fresh', 'package.json'), 10);
  for (const k of ['oldScratch', 'orchScratch', 'workerScratch'] as const) { file(paths[k], 10); old(join(paths[k], '..'), 10); }
  file(paths.newScratch, 0);
  file(paths.shipIt, 30);
  file(paths.movies, 400);
  const run = (mode: string) => spawnSync('bash', [join(root, 'scripts', 'disk-hygiene.sh'), mode], {
    encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, DISK_HYGIENE_TMP: tmp },
  });
  const dockerUp = () => writeFileSync(join(bin, 'docker'), DOCKER_UP, { mode: 0o755 });
  const calls = () => existsSync(join(bin, 'calls')) ? readFileSync(join(bin, 'calls'), 'utf8') : '';
  return { base, root, paths, run, dockerUp, calls };
}

test('dry run deletes nothing and reports what it would free', { skip: process.platform !== 'darwin' }, () => {
  const w = world();
  try {
    const r = w.run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    for (const p of Object.values(w.paths)) assert.ok(existsSync(p), `dry run kept ${p}`);
    assert.match(r.stdout, /^disk-hygiene \(dry-run\): free .* GB before, .* GB after$/m);
    assert.match(r.stdout, /docker build cache\s+skipped, Docker is not running/);
    assert.match(r.stdout, /stale node_modules\s+would free 0\.0 GB \(2 projects untouched 90\+ days: busy stale\)/);
    assert.match(r.stdout, /claude scratch\s+would free 0\.0 GB \(1 folders idle 3\+ days\)/);
    assert.match(r.stdout, /ShipIt caches\s+would free 0\.0 GB \(1 folders\)/);
    assert.ok(!existsSync(join(w.root, 'log.md')), 'dry run does not log');
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('apply deletes only stale, unowned things and logs the summary', { skip: process.platform !== 'darwin' }, () => {
  const w = world();
  try {
    const busy = spawn('sleep', ['30'], { cwd: join(w.paths.busyNm, '..', '..') });
    let r;
    try { r = w.run('--apply'); } finally { busy.kill(); }
    assert.equal(r.status, 0, r.stderr);
    const gone = ['staleNm', 'oldScratch', 'shipIt'] as const;
    for (const k of gone) assert.ok(!existsSync(w.paths[k]), `deleted ${k}`);
    for (const k of ['freshNm', 'busyNm', 'newScratch', 'orchScratch', 'workerScratch', 'movies'] as const) assert.ok(existsSync(w.paths[k]), `kept ${k}`);
    assert.ok(existsSync(join(w.paths.staleNm, '..', '..', 'package.json')), 'the project itself stays');
    const log = readFileSync(join(w.root, 'log.md'), 'utf8');
    assert.match(log, /^- \d{4}-\d\d-\d\d \d\d:\d\d disk-hygiene: free .* before, .* after\n {2}- docker build cache {5}skipped/m);
    assert.match(log, / {2}- stale node_modules {5}freed 0\.0 GB \(1 projects untouched 90\+ days: stale\)/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('with Docker up, dry run only reads and names what each Docker step would free', { skip: process.platform !== 'darwin' }, () => {
  const w = world();
  try {
    w.dockerUp();
    const r = w.run('--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /docker build cache\s+would free 2\.5 GB \(cache 7\.5 GB, keeps 5 GB\)/);
    assert.match(r.stdout, /docker images\s+would free 2\.0 GB \(1 unused, 7\+ days old/);
    assert.match(r.stdout, /worker compose stacks\s+would free 3\.0 GB of volumes \(3 stopped 7\+ days: orch-old pulse-old pulsedevwk\)/);
    assert.doesNotMatch(w.calls(), /prune|down/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('with Docker up, apply prunes and downs only stale worker stacks', { skip: process.platform !== 'darwin' }, () => {
  const w = world();
  try {
    w.dockerUp();
    const r = w.run('--apply');
    assert.equal(r.status, 0, r.stderr);
    const mutations = w.calls().split('\n').filter(l => /prune|down/.test(l));
    assert.deepEqual(mutations, ['builder prune -f --max-used-space 5GB', 'image prune -a -f --filter until=168h', 'compose -p orch-old down -v', 'compose -p pulse-old down -v', 'compose -p pulsedevwk down -v']);
    assert.match(r.stdout, /docker images\s+freed 2\.0 GB/);
  } finally { rmSync(w.base, { recursive: true, force: true }); }
});

test('anything but --dry-run or --apply is refused', () => {
  assert.equal(spawnSync('bash', [script, '--yes'], { encoding: 'utf8' }).status, 2);
});
