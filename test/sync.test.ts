import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// orch push, merge and overlap against a bare origin on disk. `git` is a shim that records every call and runs the real git;
// `gh` is fake: the PR's head comes from the bare origin, its checks from a file the test writes.
const orchTs = join(import.meta.dirname, '..', 'src', 'orch.ts');
const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const ORCH_COMMIT = 'Written by claude worker w, committed by orch after the gates passed.';

function world(autonomy = '- push: on\n- merge: on\n') {
  const base = mkdtempSync(join(tmpdir(), 'orch-sync-'));
  const origin = join(base, 'origin.git'), repo = join(base, 'repo'), wt = join(base, 'wt'), orch = join(base, 'orch'), bin = join(base, 'bin');
  for (const d of [orch, bin]) mkdirSync(d);
  const env = {
    ...process.env, ORCH_DIR: orch, PATH: `${bin}:${process.env.PATH}`, GH_DIR: base, ORIGIN: origin,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${base}/git.calls"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "$GH_DIR/gh.calls"
head=$("${realGit}" --git-dir="$ORIGIN" rev-parse refs/heads/orch/w)
checks="[]"
case "$*" in
  *isDraft*) echo "{\\"isDraft\\":false,\\"mergeable\\":\\"MERGEABLE\\",\\"reviewDecision\\":\\"\\",\\"statusCheckRollup\\":$checks,\\"headRefName\\":\\"orch/w\\",\\"baseRefName\\":\\"main\\",\\"headRefOid\\":\\"$head\\"}" ;;
  "pr merge"*) ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const sh = (cwd: string, cmd: string) => {
    const r = spawnSync('/bin/sh', ['-c', cmd], { cwd, env, encoding: 'utf8' });
    assert.equal(r.status, 0, `${cmd}: ${r.stderr}`);
    return r.stdout.trim();
  };
  sh(base, `git init -q --bare -b main ${origin} && git clone -q ${origin} ${repo} 2>/dev/null`);
  sh(repo, `printf 'a\\n' > shared.txt && printf 'x\\n' > other.txt && printf '#!/bin/sh\\ntest ! -e broken\\n' > gate.sh && chmod +x gate.sh
    git add -A && git commit -qm init && git push -q origin main && git remote set-head origin -a >/dev/null && git worktree add -q -b orch/w ${wt} main`);
  writeFileSync(join(orch, 'projects.md'), `| Repo | Path | Gates | Notes |\n|---|---|---|---|\n| demo | ${repo} | \`./gate.sh\` | |\n`);
  writeFileSync(join(orch, 'local.md'), `## Autonomy\n${autonomy}`);
  const worker = (extra = {}) => writeFileSync(join(orch, 'workers.json'), JSON.stringify([{
    name: 'w', kind: 'claude', base: sh(repo, 'git rev-parse main'), repo: 'demo', repoPath: repo, task: 't', branch: 'orch/w', worktree: wt,
    workspace: 'x', pane: 'x', sid: '', started: '2026-11-01 09:00', status: 'running', ...extra,
  }]));
  worker();
  const orchCmd = (...args: string[]) => {
    rmSync(join(base, 'git.calls'), { force: true });
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', orchTs, ...args], { env, encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr };
  };
  const commitOnWorker = (file: string) => sh(wt, `echo ${file} > ${file} && git add ${file} && git commit -qm "${file}" -m "${ORCH_COMMIT}"`);
  const mainMoves = (file: string, content = file) => sh(repo, `git checkout -q main && git pull -q --ff-only && echo ${content} > ${file} && git add -A && git commit -qm ${file} && git push -q origin main`);
  const remoteHead = () => spawnSync(realGit, ['--git-dir', origin, 'rev-parse', '--verify', '-q', 'refs/heads/orch/w'], { encoding: 'utf8' }).stdout.trim();
  const calls = (f: string) => existsSync(join(base, f)) ? readFileSync(join(base, f), 'utf8') : '';
  return { base, repo, wt, sh, worker, orch: orchCmd, commitOnWorker, mainMoves, remoteHead, calls, done: () => rmSync(base, { recursive: true, force: true }) };
}

test('push never rebases or forces: a behind branch goes up as it is', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.mainMoves('other.txt', 'y');
    const head = w.sh(w.wt, 'git rev-parse HEAD');
    const r = w.orch('push', 'w');
    assert.equal(r.status, 0, r.out);
    assert.equal(r.out.trim(), 'pushed w to origin/orch/w');
    assert.equal(w.remoteHead(), head);
    assert.doesNotMatch(w.calls('git.calls'), /rebase|force/);
  } finally { w.done(); }
});

test('merge refuses a PR behind its base and tells orch to have the worker rebase; once rebased it merges that head', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.orch('push', 'w');
    w.mainMoves('other.txt', 'y');
    w.mainMoves('third.txt');
    const before = w.sh(w.wt, 'git rev-parse HEAD');
    let r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 1);
    assert.equal(r.out.trim(), 'not merged: #7 is 2 commits behind main. Steer w to rebase onto origin/main and rerun its gates; pushing the rewritten branch needs a force push, a decision for the user.');
    assert.doesNotMatch(w.calls('gh.calls'), /pr merge/);
    assert.equal(w.sh(w.wt, 'git rev-parse HEAD'), before, 'merge never touches the worktree');
    assert.match(readFileSync(join(w.base, 'orch', 'log.md'), 'utf8'), /merge demo #7 refused: #7 is 2 commits behind main/);

    w.sh(w.wt, 'git fetch -q && git rebase -q origin/main && git push -q --force-with-lease origin HEAD:orch/w');
    r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 0, r.out);
    assert.match(w.calls('gh.calls'), new RegExp(`pr merge 7 --squash --match-head-commit ${w.remoteHead()}`));
  } finally { w.done(); }
});

test('merge of a colleague\'s PR that is behind asks its author to update it', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.sh(w.wt, 'git push -q origin HEAD:orch/w');
    w.worker({ branch: 'orch/pr7', prHead: 'orch/w' });
    w.mainMoves('other.txt', 'y');
    const r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 1);
    assert.equal(r.out.trim(), 'not merged: #7 is 1 commit behind main. Ask its author to update it.');
  } finally { w.done(); }
});

test('merge stops when the base cannot be fetched', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.orch('push', 'w');
    w.sh(w.repo, 'git remote set-url origin /nonexistent/origin.git');
    const r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 1);
    assert.match(r.out, /not merged: git fetch origin failed in .*repo, so #7 could not be checked against main/);
    assert.doesNotMatch(w.calls('gh.calls'), /pr merge/);
  } finally { w.done(); }
});

// Overlap glue: two more workers on the demo repo, each in its own worktree.
function overlapWorld() {
  const w = world();
  const wt = (name: string, from = 'origin/main') => {
    const path = join(w.base, `wt-${name}`);
    w.sh(w.repo, `git worktree add -q -b orch/${name} ${path} ${from}`);
    return path;
  };
  const rec = (name: string, path: string, started: string, extra = {}) => ({
    name, kind: 'claude', repo: 'demo', repoPath: w.repo, task: 't', branch: `orch/${name}`, worktree: path,
    workspace: 'x', pane: 'x', sid: '', started, status: 'running', ...extra,
  });
  const save = (rs: object[]) => writeFileSync(join(w.base, 'orch', 'workers.json'), JSON.stringify(rs));
  return { ...w, wt, rec, save };
}

test('overlap finds committed, staged, unstaged and untracked changes, and nothing outside the branch', () => {
  const w = overlapWorld();
  try {
    const a = w.wt('a'), b = w.wt('b');
    w.save([w.rec('a', a, '2026-11-01 09:00'), w.rec('b', b, '2026-11-01 10:00')]);
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'no overlap', 'two branches at the same commit as main change nothing');
    w.sh(a, 'echo a > committed.txt && git add committed.txt && git commit -qm c && echo a > staged.txt && git add staged.txt && echo a >> other.txt && echo a > untracked.txt && echo a > solo-a.txt');
    w.sh(b, 'echo b > committed.txt && echo b > staged.txt && echo b >> other.txt && echo b > untracked.txt && echo b > solo-b.txt && git add -A && git commit -qm all');
    w.mainMoves('main-only.txt');
    const r = w.orch('overlap', 'demo');
    assert.equal(r.out.trim(), 'OVERLAP demo: b (later) and a both change 4 files: committed.txt, other.txt, staged.txt, untracked.txt');
  } finally { w.done(); }
});

test('overlap skips a stacked child by merge-base and a Claude/Codex pair, and --new keeps state per pair', () => {
  const w = overlapWorld();
  try {
    const parent = w.wt('parent');
    w.sh(parent, 'echo p > shared.txt && git commit -qam parent');
    const child = w.wt('child', 'orch/parent');
    w.sh(child, 'echo c > shared.txt && git commit -qam child');
    const cl = w.wt('fix-cl'), cx = w.wt('fix-cx');
    for (const p of [cl, cx]) w.sh(p, 'echo f > shared.txt');
    w.save([w.rec('parent', parent, '1'), w.rec('child', child, '2'), w.rec('fix-cl', cl, '3', { pair: 'fix' }), w.rec('fix-cx', cx, '3', { pair: 'fix' })]);
    assert.deepEqual(w.orch('overlap', 'demo').out.trim().split('\n'), [
      'OVERLAP demo: fix-cl (later) and parent both change 1 file: shared.txt',
      'OVERLAP demo: fix-cx (later) and parent both change 1 file: shared.txt',
      'OVERLAP demo: fix-cl (later) and child both change 1 file: shared.txt',
      'OVERLAP demo: fix-cx (later) and child both change 1 file: shared.txt',
    ]);
    // Once the parent lands, main and the parent branch are the same commit: the parent changes nothing, and the
    // commits the two share are on main, so the pair is no stack any more. A new parent change is a plain overlap.
    w.sh(w.repo, 'git push -q origin orch/parent:main');
    w.save([w.rec('parent', parent, '1'), w.rec('child', child, '2')]);
    assert.equal(w.orch('overlap', '--new').out.trim(), '');
    w.sh(parent, 'echo p2 > shared.txt');
    assert.equal(w.orch('overlap', '--new').out.trim(), 'OVERLAP demo: child (later) and parent both change 1 file: shared.txt');
    assert.equal(w.orch('overlap', '--new').out.trim(), '', 'reported once');
    assert.deepEqual(JSON.parse(readFileSync(join(w.base, 'orch', 'overlap.json'), 'utf8')), { 'demo parent child': ['shared.txt'] });
  } finally { w.done(); }
});

test('the watcher prints an OVERLAP error line when the check fails', async () => {
  const base = mkdtempSync(join(tmpdir(), 'orch-watch-'));
  try {
    for (const d of ['feed', 'ideas']) mkdirSync(join(base, d));
    writeFileSync(join(base, 'ideas', 'config.json'), '{"adapter":"mock"}');
    writeFileSync(join(base, 'ideas', 'off'), '');
    writeFileSync(join(base, 'workers.json'), '{not json');
    const { spawn } = await import('node:child_process');
    const c = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '..', 'src', 'watch.ts')],
      { env: { ...process.env, ORCH_DIR: base, ORCH_SID: 'test' } });
    const line = await new Promise<string>((done, fail) => {
      const t = setTimeout(() => fail(new Error('no OVERLAP line in 15 s')), 15_000);
      let out = '';
      c.stdout.on('data', d => { out += d; const m = out.match(/^OVERLAP .*$/m); if (m) { clearTimeout(t); done(m[0]); } });
    }).finally(() => c.kill());
    assert.match(line, /^OVERLAP error: check exited 1: .*JSON/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
