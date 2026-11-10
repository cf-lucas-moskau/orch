import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End to end on a throwaway origin and deploy checkout; backup and d14 are npm scripts that record their runs outside it.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-evr-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work'), dir = join(root, 'deploy'), runsFile = join(root, 'runs'), tmp = join(root, 'tmp');
  mkdirSync(tmp);
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  mkdirSync(join(work, 'packages', 'db', 'migrations'), { recursive: true });
  writeFileSync(join(work, '.gitignore'), 'releases/\n');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts: { 'alpha:backup': 'node backup.js', 'alpha:d14': 'node d14.js' } }));
  writeFileSync(join(work, 'backup.js'), `require('fs').appendFileSync(process.env.RUNS, 'backup\\n'); console.log('backup verified'); process.exit(Number(process.env.BACKUP_EXIT ?? 0));`);
  writeFileSync(join(work, 'd14.js'), `const fs = require('fs'), { execSync } = require('child_process');
fs.appendFileSync(process.env.RUNS, 'd14 ' + process.argv.slice(2).join(' ') + '\\n');
console.log('noise'); console.log('d14 done');
const code = Number(process.env.D14_EXIT ?? 0);
if (!code) { fs.mkdirSync('releases/current', { recursive: true }); fs.writeFileSync('releases/current/manifest.json', JSON.stringify({ commit: execSync('git rev-parse --short=8 HEAD').toString().trim() })); }
process.exit(code);`);
  writeFileSync(join(work, 'packages', 'db', 'migrations', '001_init.sql'), 'CREATE TABLE heroes (id int, mood text);\n');
  const commit = (path: string, text: string) => { writeFileSync(join(work, path), text); g(work, 'add', '-A'); g(work, 'commit', '-qm', path); g(work, 'push', '-q', 'origin', 'HEAD:main'); return g(work, 'rev-parse', 'HEAD'); };
  const first = commit('README.md', 'evrloot\n');
  execFileSync('git', ['clone', '-q', origin, dir]);
  mkdirSync(join(dir, 'releases', 'current'), { recursive: true });
  writeFileSync(join(dir, 'releases', 'current', 'manifest.json'), JSON.stringify({ release: 'r1', commit: first.slice(0, 8) }));
  const deploy = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '..', 'src', 'deploy-evrloot.ts')],
      { env: { ...process.env, EVR_DEPLOY_DIR: dir, RUNS: runsFile, TMPDIR: tmp, ...env }, encoding: 'utf8' });
  const runs = () => existsSync(runsFile) ? readFileSync(runsFile, 'utf8') : '';
  return { dir, tmp, first, commit, deploy, runs, head: () => g(dir, 'rev-parse', 'HEAD'), g };
}

test('a release without migrations deploys: fast-forward, backup verify, d14 A, summary lines only', () => {
  const w = world();
  const next = w.commit('README.md', 'evrloot, now with quests\n');
  const r = w.deploy();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `deploy ${next.slice(0, 8)} (8790 runs ${w.first.slice(0, 8)})\nbackup verified\nd14 done\n`);
  assert.equal(w.head(), next);
  assert.equal(w.runs(), 'backup\nd14 A --yes\n');
  assert.deepEqual(readdirSync(w.tmp).filter(f => f.startsWith('deploy-evrloot-')), [], 'the step logs are removed after a successful deploy');
  assert.equal(w.deploy().status, 0, 'a rerun on the deployed revision deploys nothing new and passes');
});

test('any migration since the running release stops the deploy with the files listed, again on a rerun, even after a manual fast-forward', () => {
  const w = world();
  w.commit('packages/db/migrations/002_quests.sql', 'CREATE TABLE quests (id int);\n');
  w.commit('packages/db/migrations/001_init.sql', 'CREATE TABLE heroes (id int);\n');
  const r = w.deploy();
  assert.equal(r.status, 3);
  assert.equal(r.stderr, `deploy stopped: migrations since ${w.first.slice(0, 8)} need Lucas:\npackages/db/migrations/001_init.sql\npackages/db/migrations/002_quests.sql\n`);
  assert.equal(w.head(), w.first, 'the checkout did not move');
  assert.equal(w.deploy().status, 3, 'a rerun refuses again');
  w.g(w.dir, 'merge', '--ff-only', '-q', 'origin/main');
  assert.equal(w.deploy().status, 3, 'checked against what 8790 runs, not against HEAD');
  assert.equal(w.runs(), '', 'no backup, no d14');
});

test('untracked logs outside the migrations folder do not stop a deploy', () => {
  const w = world();
  const next = w.commit('README.md', 'next\n');
  writeFileSync(join(w.dir, 'd14-A-x.log'), 'old run\n');
  writeFileSync(join(w.dir, 'alpha-prod.log'), 'live server\n');
  const r = w.deploy();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(w.head(), next);
  assert.equal(readFileSync(join(w.dir, 'alpha-prod.log'), 'utf8'), 'live server\n', 'left alone');
});

test('a tracked change, an untracked migration or a local commit stops the deploy before anything runs', () => {
  const w = world();
  writeFileSync(join(w.dir, 'package.json'), '{}');
  let r = w.deploy();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has uncommitted changes:\n ?M package\.json/);
  w.g(w.dir, 'checkout', '-q', '--', 'package.json');
  writeFileSync(join(w.dir, 'packages', 'db', 'migrations', '009_local.sql'), 'DROP TABLE heroes;\n');
  r = w.deploy();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has untracked migration files:\n\?\? packages\/db\/migrations\/009_local\.sql/);
  w.g(w.dir, 'clean', '-qf');
  w.g(w.dir, 'config', 'user.email', 't@t'); w.g(w.dir, 'config', 'user.name', 't');
  w.g(w.dir, 'commit', '-q', '--allow-empty', '-m', 'local');
  r = w.deploy();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not on origin\/main/);
  assert.equal(w.runs(), '');
});

test('a failed backup verify stops before d14; d14 failing keeps its own exit status', () => {
  const w = world();
  w.commit('README.md', 'next\n');
  let r = w.deploy({ BACKUP_EXIT: '1' });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /backup exited 1; full log .*backup\.log\ndeploy stopped: backup verify failed/);
  assert.equal(w.runs(), 'backup\n');
  assert.equal(w.head(), w.first, 'a failed backup verify leaves the checkout where it was');
  r = w.deploy({ D14_EXIT: '7' });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /d14 done\nd14 exited 7/);
});
