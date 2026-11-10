// Deploys evrloot-next to world 8790 (d14 step A: same world, new code), the one way orch and the Evrloot lead ship it:
// `npm run -s deploy:evrloot`, one command so the allow rule for `npm run *` matches it (local.md has the approval).
// Every check runs against what 8790 runs now (releases/current/manifest.json) before the checkout moves, so a rerun
// after a refusal refuses again. Any migration in that range stops it: Lucas approves each one (they are rare), so
// nothing here tries to judge SQL. Exit codes: 2 checkout not deployable, 3 migrations need Lucas (listed on stderr),
// 4 backup verify failed, otherwise d14's own. EVR_DEPLOY_DIR points it at another checkout (tests).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = process.env.EVR_DEPLOY_DIR ?? join(homedir(), 'code', 'evrloot-next-deploy');
const stop = (code: number, msg: string): never => { console.error(`deploy stopped: ${msg}`); process.exit(code); };
const git = (...args: string[]) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) stop(2, `git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
};
const isAncestor = (a: string, b: string) => spawnSync('git', ['-C', dir, 'merge-base', '--is-ancestor', a, b]).status === 0;

git('fetch', '-q', 'origin');
// Tracked changes anywhere stop it. Untracked files only under the migrations folder do, since those could run against
// the database; logs elsewhere (d14's, the live server's alpha-prod.log) belong there.
const list = (s: string) => s.split('\n').slice(0, 10).join('\n');
const modified = git('status', '--porcelain', '--untracked-files=no');
if (modified) stop(2, `${dir} has uncommitted changes:\n${list(modified)}`);
const strays = git('status', '--porcelain', '--untracked-files=all', '--', 'packages/db/migrations');
if (strays) stop(2, `${dir} has untracked migration files:\n${list(strays)}`);
const head = git('rev-parse', 'HEAD'), main = git('rev-parse', 'origin/main');
if (!isAncestor(head, main)) stop(2, `HEAD ${head.slice(0, 8)} is not on origin/main`);
let commit: string;
try { commit = JSON.parse(readFileSync(join(dir, 'releases', 'current', 'manifest.json'), 'utf8')).commit; }
catch (e) { stop(2, `cannot tell what 8790 runs (releases/current/manifest.json): ${e instanceof Error ? e.message : e}`); }
const deployed = git('rev-parse', `${commit!}^{commit}`);
if (!isAncestor(deployed, main)) stop(2, `8790 runs ${deployed.slice(0, 8)}, which is not on origin/main`);
const migrations = git('diff', '--name-only', '--no-renames', deployed, main, '--', 'packages/db/migrations');
if (migrations) stop(3, `migrations since ${deployed.slice(0, 8)} need Lucas:\n${migrations}`);

git('merge', '--ff-only', '-q', main);
if (git('rev-parse', 'HEAD') !== main) stop(2, 'HEAD is not origin/main after the fast-forward');
console.log(`deploy ${main.slice(0, 8)} (8790 runs ${deployed.slice(0, 8)})`);

const logs = mkdtempSync(join(tmpdir(), 'deploy-evrloot-'));
// Output goes to a log; the summary lines are printed, the exit status is the step's own.
function step(name: string, args: string[], summary: (lines: string[]) => string[]) {
  const r = spawnSync('npm', ['run', '-s', ...args], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  writeFileSync(join(logs, `${name}.log`), out);
  const lines = out.trim().split('\n');
  if (r.status === 0) { for (const l of summary(lines)) console.log(l); return 0; }
  console.error(lines.slice(-8).join('\n'));
  console.error(`${name} exited ${r.status ?? r.signal}; full log ${join(logs, `${name}.log`)}`);
  return r.status ?? 1;
}
if (step('backup', ['alpha:backup', '--', '--verify'], ls => ls.slice(-1))) stop(4, 'backup verify failed');
process.exit(step('d14', ['alpha:d14', '--', 'A', '--yes'],
  ls => ls.filter(l => /^(ok|warn|d14|die|error)|not ok|Error/.test(l) && !/^ok {3}[a-z -]+: [0-9]+$/.test(l))));
