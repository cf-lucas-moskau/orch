import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataLoss, migrationBlocker } from '../src/deploy.ts';

test('a statement that drops or deletes data is found across lines, comments and literals aside', () => {
  assert.equal(dataLoss('ALTER TABLE heroes\n  DROP\n  COLUMN mood;'), 'ALTER TABLE heroes DROP COLUMN mood');
  assert.equal(dataLoss('alter table x add column y int;\nTRUNCATE\n\tevents;'), 'TRUNCATE events');
  assert.equal(dataLoss('DELETE\nFROM ledger WHERE id = 1;'), 'DELETE FROM ledger WHERE id = 1');
  assert.equal(dataLoss('/* drop old */ CREATE TABLE t (drop_points int); -- truncate later\nINSERT INTO t VALUES (1);'), null);
  assert.equal(dataLoss("INSERT INTO notes VALUES ('we will drop it; delete from x');"), null);
  assert.equal(dataLoss('CREATE INDEX i ON t (a);'), null);
});

test('migrations since the running release: added ones are checked whole, any other change is refused', () => {
  const files: Record<string, string> = { 'm/031_a.sql': 'CREATE TABLE a (id int);', 'm/032_b.sql': 'ALTER TABLE a\nDROP COLUMN id;' };
  const show = (p: string) => files[p];
  assert.equal(migrationBlocker('A\tm/031_a.sql\n', show), null);
  assert.equal(migrationBlocker('A\tm/031_a.sql\nA\tm/032_b.sql\n', show), 'm/032_b.sql drops or deletes data: ALTER TABLE a DROP COLUMN id');
  assert.equal(migrationBlocker('M\tm/031_a.sql', show), 'm/031_a.sql was changed after it shipped');
  assert.equal(migrationBlocker('D\tm/031_a.sql', show), 'm/031_a.sql was deleted after it shipped');
  assert.equal(migrationBlocker('R100\tm/031_a.sql\tm/033_a.sql', show), 'm/031_a.sql was renamed or replaced after it shipped');
  assert.equal(migrationBlocker('M\tm/README.md', show), null);
});

// End to end on a throwaway origin and deploy checkout; backup and d14 are npm scripts that record their runs.
function world() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-evr-'));
  const origin = join(root, 'origin.git'), work = join(root, 'work'), dir = join(root, 'deploy');
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  g(work, 'config', 'user.email', 't@t'); g(work, 'config', 'user.name', 't');
  mkdirSync(join(work, 'packages', 'db', 'migrations'), { recursive: true });
  writeFileSync(join(work, '.gitignore'), 'releases/\n');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ scripts: { 'alpha:backup': 'node backup.js', 'alpha:d14': 'node d14.js' } }));
  writeFileSync(join(work, 'backup.js'), `require('fs').appendFileSync('runs', 'backup\\n'); console.log('backup verified'); process.exit(Number(process.env.BACKUP_EXIT ?? 0));`);
  writeFileSync(join(work, 'd14.js'), `const fs = require('fs'), { execSync } = require('child_process');
fs.appendFileSync('runs', 'd14 ' + process.argv.slice(2).join(' ') + '\\n');
console.log('noise'); console.log('d14 done');
const code = Number(process.env.D14_EXIT ?? 0);
if (!code) { fs.mkdirSync('releases/current', { recursive: true }); fs.writeFileSync('releases/current/manifest.json', JSON.stringify({ commit: execSync('git rev-parse --short=8 HEAD').toString().trim() })); }
process.exit(code);`);
  writeFileSync(join(work, 'packages', 'db', 'migrations', '001_init.sql'), 'CREATE TABLE heroes (id int, mood text);\n');
  const commit = (msg: string) => { g(work, 'add', '-A'); g(work, 'commit', '-qm', msg); g(work, 'push', '-q', 'origin', 'HEAD:main'); return g(work, 'rev-parse', 'HEAD'); };
  const first = commit('init');
  execFileSync('git', ['clone', '-q', origin, dir]);
  mkdirSync(join(dir, 'releases', 'current'), { recursive: true });
  writeFileSync(join(dir, 'releases', 'current', 'manifest.json'), JSON.stringify({ release: 'r1', commit: first.slice(0, 8) }));
  const migration = (name: string, sql: string) => { writeFileSync(join(work, 'packages', 'db', 'migrations', name), sql); return commit(name); };
  const deploy = (env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '..', 'src', 'deploy-evrloot.ts')],
      { env: { ...process.env, EVR_DEPLOY_DIR: dir, ...env }, encoding: 'utf8' });
  const runs = () => existsSync(join(dir, 'runs')) ? readFileSync(join(dir, 'runs'), 'utf8') : '';
  return { dir, first, migration, deploy, runs, head: () => g(dir, 'rev-parse', 'HEAD'), g };
}

test('an additive release deploys: fast-forward, backup verify, d14 A, summary lines only', () => {
  const w = world();
  const next = w.migration('002_quests.sql', 'CREATE TABLE quests (id int);\n');
  const r = w.deploy();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `deploy ${next.slice(0, 8)} (8790 runs ${w.first.slice(0, 8)})\nbackup verified\nd14 done\n`);
  assert.equal(w.head(), next);
  assert.equal(w.runs(), 'backup\nd14 A --yes\n');
});

test('a refused migration stays refused on a rerun, even after the checkout moved by hand', () => {
  const w = world();
  w.migration('002_drop.sql', 'ALTER TABLE heroes\n  DROP COLUMN mood;\n');
  const r = w.deploy();
  assert.equal(r.status, 3);
  assert.match(r.stderr, /deploy stopped: packages\/db\/migrations\/002_drop\.sql drops or deletes data: ALTER TABLE heroes DROP COLUMN mood; that one goes to Lucas/);
  assert.equal(w.head(), w.first, 'the checkout did not move');
  assert.equal(w.deploy().status, 3, 'a rerun refuses again');
  w.g(w.dir, 'merge', '--ff-only', '-q', 'origin/main');
  assert.equal(w.deploy().status, 3, 'checked against what 8790 runs, not against HEAD');
  assert.equal(w.runs(), '', 'no backup, no d14');
});

test('a dirty checkout or local commits stop the deploy before anything runs', () => {
  const w = world();
  writeFileSync(join(w.dir, 'package.json'), '{}');
  let r = w.deploy();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has uncommitted changes/);
  w.g(w.dir, 'checkout', '-q', '--', 'package.json');
  w.g(w.dir, 'config', 'user.email', 't@t'); w.g(w.dir, 'config', 'user.name', 't');
  w.g(w.dir, 'commit', '-q', '--allow-empty', '-m', 'local');
  r = w.deploy();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not on origin\/main/);
  assert.equal(w.runs(), '');
});

test('a failed backup verify stops before d14; d14 failing keeps its own exit status', () => {
  const w = world();
  w.migration('002_quests.sql', 'CREATE TABLE quests (id int);\n');
  let r = w.deploy({ BACKUP_EXIT: '1' });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /backup exited 1; full log .*backup\.log\ndeploy stopped: backup verify failed/);
  assert.equal(w.runs(), 'backup\n');
  r = w.deploy({ D14_EXIT: '7' });
  assert.equal(r.status, 7);
  assert.match(r.stderr, /d14 done\nd14 exited 7/);
});
