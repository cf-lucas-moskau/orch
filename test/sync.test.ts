import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// orch run, push, merge and overlap against a bare origin on disk. `git` is a shim that records every call and runs the real git.
// `gh` is fake: PR #7's head is orch/w in the bare origin, its base `main` or gh.base, merged PRs are `<branch> <head sha>` lines in gh.merged,
// and gh.fail makes `pr list` fail.
// `herdr` is fake: it creates real worktrees, and no agent ever starts, so `run` stops after saving the worker.
const orchTs = join(import.meta.dirname, '..', 'src', 'orch.ts');
const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
// Every local.md a test writes starts here, so no test depends on this machine's free disk.
const HERMETIC_LOCAL = 'Disk floor: 0 GB\n';
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
head=$("${realGit}" --git-dir="$ORIGIN" rev-parse refs/heads/orch/w 2>/dev/null)
base=$(cat "$GH_DIR/gh.base" 2>/dev/null || echo main)
case "$*" in
  *isDraft*) echo "{\\"isDraft\\":false,\\"mergeable\\":\\"MERGEABLE\\",\\"reviewDecision\\":\\"\\",\\"statusCheckRollup\\":[],\\"headRefName\\":\\"orch/w\\",\\"baseRefName\\":\\"$base\\",\\"headRefOid\\":\\"$head\\"}" ;;
  "pr list --head "*) [ -e "$GH_DIR/gh.fail" ] && { echo "HTTP 502: Bad Gateway" >&2; exit 1; }; grep "^$4 " "$GH_DIR/gh.merged" 2>/dev/null | cut -d' ' -f2 ;;
  "pr merge"*) ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh
case "$1 $2" in
  "worktree create") shift 2; while [ $# -gt 0 ]; do case "$1" in --cwd) cwd=$2;; --branch) br=$2;; --base) from=$2;; esac; shift; done
    path="$GH_DIR/wt-\${br#orch/}"; "${realGit}" -C "$cwd" worktree add -q -b "$br" "$path" \${from:-HEAD} >&2
    echo "{\\"result\\":{\\"root_pane\\":{\\"pane_id\\":\\"p1\\"},\\"workspace\\":{\\"workspace_id\\":\\"ws\\"},\\"worktree\\":{\\"path\\":\\"$path\\"}}}" ;;
  "agent start") echo '{"error":{"code":"fake","message":"no agent in tests"}}' ;;
  *) echo '{}' ;;
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
  writeFileSync(join(orch, 'local.md'), `${HERMETIC_LOCAL}## Autonomy\n${autonomy}`);
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

test('merge refuses a PR behind its base; once the worker merges the base in, a normal push updates it and it merges', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.orch('push', 'w');
    w.mainMoves('other.txt', 'y');
    w.mainMoves('third.txt');
    const before = w.sh(w.wt, 'git rev-parse HEAD');
    let r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 1);
    assert.equal(r.out.trim(), 'not merged: #7 is 2 commits behind main. Have w merge origin/main into its branch and rerun its gates, then push and merge again.');
    assert.doesNotMatch(w.calls('gh.calls'), /pr merge/);
    assert.equal(w.sh(w.wt, 'git rev-parse HEAD'), before, 'merge never touches the worktree');
    assert.match(readFileSync(join(w.base, 'orch', 'log.md'), 'utf8'), /merge demo #7 refused: #7 is 2 commits behind main/);

    // What the brief tells the worker, with an uncommitted change in the tree.
    w.sh(w.wt, 'echo wip > wip.txt && git fetch -q origin && git merge -q --autostash --no-edit origin/main');
    assert.equal(w.sh(w.wt, 'git rev-list --parents -n1 HEAD').split(' ').length, 3, 'a merge commit');
    assert.equal(w.sh(w.wt, 'git status --porcelain'), '?? wip.txt');
    w.sh(w.wt, 'rm wip.txt');
    r = w.orch('push', 'w');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(w.calls('git.calls'), /force/);
    assert.equal(w.remoteHead(), w.sh(w.wt, 'git rev-parse HEAD'));
    w.sh(w.wt, `git merge-base --is-ancestor ${before} HEAD`);
    r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 0, r.out);
    assert.match(w.calls('gh.calls'), new RegExp(`pr merge 7 --squash --match-head-commit ${w.remoteHead()}`));
  } finally { w.done(); }
});

test('a stacked child merges after its parent was squash-merged, without updating; a real new base commit still refuses', () => {
  const w = world();
  try {
    w.sh(w.repo, 'git checkout -q -b orch/parent main && echo p > shared.txt && git commit -qam parent && echo p2 > p2.txt && git add p2.txt && git commit -qm parent2 && git push -q origin orch/parent');
    w.sh(w.wt, 'git reset -q --hard orch/parent');
    w.commitOnWorker('one.txt');
    w.sh(w.wt, 'git push -q origin HEAD:orch/w');
    writeFileSync(join(w.base, 'gh.base'), 'orch/parent');
    writeFileSync(join(w.base, 'gh.merged'), `orch/parent ${w.sh(w.repo, 'git rev-parse orch/parent')}\n`);
    w.sh(w.repo, 'git checkout -q main && git merge -q --squash orch/parent && git commit -qm "parent (#6)" && git push -q origin main');
    let r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 1);
    assert.equal(r.out.trim(), 'not merged: #7 targets orch/parent, which is already merged. Retarget it first: gh pr edit 7 --base <default branch>');
    writeFileSync(join(w.base, 'gh.base'), 'main');
    const head = w.remoteHead();
    r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 0, r.out);
    assert.match(w.calls('gh.calls'), new RegExp(`pr merge 7 --squash --match-head-commit ${head}`));
    assert.equal(w.remoteHead(), head, 'no push, no rewrite');
    w.mainMoves('other.txt', 'y');
    r = w.orch('merge', 'demo', '7');
    assert.equal(r.out.trim(), 'not merged: #7 is 2 commits behind main. Have w merge origin/main into its branch and rerun its gates, then push and merge again.',
      'the squash is counted once something else is missing too');
    // The parent branch reused with new commits is not merged any more: merging into it is the plan, no retarget needed.
    w.sh(w.repo, 'git checkout -q orch/parent && echo n > n.txt && git add n.txt && git commit -qm next && git push -q origin orch/parent');
    writeFileSync(join(w.base, 'gh.base'), 'orch/parent');
    r = w.orch('merge', 'demo', '7');
    assert.match(r.out, /not merged: #7 is 1 commit behind orch\/parent/);
    writeFileSync(join(w.base, 'gh.fail'), '');
    r = w.orch('merge', 'demo', '7');
    assert.equal(r.out.trim(), 'merge stopped: gh pr list --head orch/parent failed, so whether #7\'s base is merged is unknown: HTTP 502: Bad Gateway');
  } finally { w.done(); }
});

test('the merged-base guard applies only to orch branches, never to main', () => {
  const w = world();
  try {
    w.commitOnWorker('one.txt');
    w.orch('push', 'w');
    writeFileSync(join(w.base, 'gh.merged'), `main ${w.sh(w.repo, 'git rev-parse origin/main')}\n`);
    const r = w.orch('merge', 'demo', '7');
    assert.equal(r.status, 0, r.out);
    assert.doesNotMatch(w.calls('gh.calls'), /pr list/);
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

test('overlap skips a child started on its parent\'s head and a Claude/Codex pair, not branches that merely share history', () => {
  const w = overlapWorld();
  try {
    const parent = w.wt('parent');
    w.sh(parent, 'echo p > shared.txt && git commit -qam parent');
    const child = w.wt('child', 'orch/parent');
    w.sh(child, 'echo c > shared.txt && git commit -qam child');
    // Started on an older commit of the parent, so not its child: their shared, unmerged history does not hide the overlap.
    w.sh(parent, 'echo p2 > p2.txt && git add p2.txt && git commit -qm p2');
    const cousin = w.wt('cousin', 'orch/parent~1');
    w.sh(cousin, 'echo k > p2.txt');
    const cl = w.wt('fix-cl'), cx = w.wt('fix-cx');
    for (const p of [cl, cx]) w.sh(p, 'echo f > other.txt');
    w.save([w.rec('parent', parent, '1'), w.rec('child', child, '2', { parent: 'parent' }), w.rec('cousin', cousin, '3'),
      w.rec('fix-cl', cl, '4', { pair: 'fix' }), w.rec('fix-cx', cx, '4', { pair: 'fix' })]);
    assert.deepEqual(w.orch('overlap', 'demo').out.trim().split('\n'), [
      'OVERLAP demo: cousin (later) and parent both change 2 files: p2.txt, shared.txt',
      'OVERLAP demo: cousin (later) and child both change 1 file: shared.txt',
    ]);
  } finally { w.done(); }
});

test('a merged worker stops overlapping, even squashed; what it landed no longer counts for its child', () => {
  const w = overlapWorld();
  try {
    const parent = w.wt('parent');
    w.sh(parent, 'echo p > shared.txt && git commit -qam parent');
    const child = w.wt('child', 'orch/parent');
    w.sh(child, 'echo c > child.txt && git add child.txt && git commit -qm child');
    const other = w.wt('other');
    w.sh(other, 'echo o > shared.txt');
    w.save([w.rec('parent', parent, '1'), w.rec('child', child, '2', { parent: 'parent' }), w.rec('other', other, '3')]);
    assert.deepEqual(w.orch('overlap', '--new').out.trim().split('\n'), [
      'OVERLAP demo: other (later) and parent both change 1 file: shared.txt',
      'OVERLAP demo: other (later) and child both change 1 file: shared.txt',
    ]);
    w.sh(w.repo, 'git checkout -q main && git merge -q --squash orch/parent && git commit -qm "parent (#6)" && git push -q origin main');
    // The squash landed shared.txt: the child no longer changes it, and neither does the parent's branch.
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'no overlap');
    // A merged worker left running with a stray edit is still done: its PR is merged, so it is out.
    w.sh(parent, 'echo stray > shared.txt');
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'OVERLAP demo: other (later) and parent both change 1 file: shared.txt');
    writeFileSync(join(w.base, 'gh.merged'), `orch/parent ${w.sh(parent, 'git rev-parse HEAD')}\n`);
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'no overlap');
    writeFileSync(join(w.base, 'gh.fail'), '');
    assert.deepEqual(w.orch('overlap', 'demo').out.trim().split('\n'), [
      'OVERLAP error: demo: gh pr list for parent failed: HTTP 502: Bad Gateway',
      'OVERLAP error: demo: gh pr list for child failed: HTTP 502: Bad Gateway',
      'OVERLAP error: demo: gh pr list for other failed: HTTP 502: Bad Gateway',
      'OVERLAP demo: other (later) and parent both change 1 file: shared.txt',
    ], 'a gh failure is said, and the workers are still checked');
    rmSync(join(w.base, 'gh.fail'));
    // The branch reused after its merge: new commits make it count again.
    w.sh(parent, 'git commit -qam reuse');
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'OVERLAP demo: other (later) and parent both change 1 file: shared.txt');
  } finally { w.done(); }
});

test('conflicted paths count as touched: two workers that both conflict with main on a file overlap on it', () => {
  const w = overlapWorld();
  try {
    const a = w.wt('a'), b = w.wt('b');
    w.sh(a, 'echo changed > shared.txt && git commit -qam a');
    w.sh(b, 'git rm -q shared.txt && git commit -qm b');
    w.mainMoves('shared.txt', 'main');
    w.save([w.rec('a', a, '1'), w.rec('b', b, '2')]);
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'OVERLAP demo: b (later) and a both change 1 file: shared.txt');
  } finally { w.done(); }
});

test('an unknown origin/HEAD is learned once with set-head, else origin/main with a warning line, never skipped silently', () => {
  const w = overlapWorld();
  try {
    const a = w.wt('a'), b = w.wt('b');
    for (const p of [a, b]) w.sh(p, 'echo z > shared.txt');
    w.save([w.rec('a', a, '1'), w.rec('b', b, '2')]);
    w.sh(w.repo, 'git symbolic-ref -d refs/remotes/origin/HEAD');
    assert.equal(w.orch('overlap', 'demo').out.trim(), 'OVERLAP demo: b (later) and a both change 1 file: shared.txt');
    assert.match(w.calls('git.calls'), /remote set-head origin -a/);
    assert.equal(w.sh(w.repo, 'git symbolic-ref --short refs/remotes/origin/HEAD'), 'origin/main');

    w.sh(w.repo, 'git symbolic-ref -d refs/remotes/origin/HEAD');
    w.sh(w.base, `git --git-dir=${join(w.base, 'origin.git')} symbolic-ref HEAD refs/heads/nope`);
    assert.deepEqual(w.orch('overlap', 'demo').out.trim().split('\n'), [
      `OVERLAP warning: demo: origin/HEAD is unknown in ${w.repo} (git remote set-head origin -a failed); using origin/main`,
      'OVERLAP demo: b (later) and a both change 1 file: shared.txt',
    ]);
    assert.equal((w.calls('git.calls').match(/remote set-head/g) ?? []).length, 1, 'set-head is tried once');
  } finally { w.done(); }
});

test('a repo whose fetch fails is skipped with an error line, and the other repos are still checked', () => {
  const w = overlapWorld();
  try {
    const repo2 = join(w.base, 'repo2');
    w.sh(w.base, `git clone -q ${join(w.base, 'origin.git')} ${repo2} 2>/dev/null && cd ${repo2} && git remote set-head origin -a >/dev/null`);
    writeFileSync(join(w.base, 'orch', 'projects.md'), `| Repo | Path | Gates | Notes |\n|---|---|---|---|\n| demo | ${w.repo} | \`./gate.sh\` | |\n| demo2 | ${repo2} | | |\n`);
    const a = w.wt('a'), b = w.wt('b');
    const wt2 = (name: string) => { const p = join(w.base, `wt2-${name}`); w.sh(repo2, `git worktree add -q -b orch/${name} ${p} origin/main && echo x > ${p}/shared.txt`); return p; };
    const c = wt2('c'), d = wt2('d');
    for (const p of [a, b]) w.sh(p, 'echo z > shared.txt');
    const two = (name: string, path: string, started: string) => ({ ...w.rec(name, path, started), repo: 'demo2', repoPath: repo2 });
    w.save([w.rec('a', a, '1'), w.rec('b', b, '2'), two('c', c, '3'), two('d', d, '4')]);
    writeFileSync(join(w.base, 'orch', 'overlap.json'), JSON.stringify({ 'demo2 c d': ['shared.txt'] }));
    w.sh(repo2, 'git remote set-url origin /nonexistent/origin.git');
    const r = w.orch('overlap', '--new');
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.out.trim().split('\n'), [
      `OVERLAP error: demo2: git fetch origin failed in ${repo2}; skipped`,
      'OVERLAP demo: b (later) and a both change 1 file: shared.txt',
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(w.base, 'orch', 'overlap.json'), 'utf8')),
      { 'demo2 c d': ['shared.txt'], 'demo a b': ['shared.txt'] }, 'the skipped repo keeps what was already reported');
  } finally { w.done(); }
});

test('run: --from main is the default branch however spelled, a child gets its parent, and a failed fetch falls back with a warning', () => {
  const w = world();
  try {
    writeFileSync(join(w.base, 'orch', 'local.md'), `${HERMETIC_LOCAL}Concurrency cap: 9\n`);
    const main = w.sh(w.repo, 'git rev-parse main');
    let r = w.orch('run', 'demo', 'same', 'task', '--from', 'main');
    assert.match(r.out, /worker same is not ready/);
    assert.doesNotMatch(w.calls('git.calls'), /fetch/, 'with --from nothing is fetched');
    const rec = (name: string) => JSON.parse(readFileSync(join(w.base, 'orch', 'workers.json'), 'utf8')).find((x: any) => x.name === name);
    assert.equal(rec('same').base, main);
    assert.equal(rec('same').parent, undefined, 'orch/w is at main too, but main is no parent');

    // orch/w is now behind main with no commits of its own: an older base, not a parent.
    w.mainMoves('other.txt', 'y');
    r = w.orch('run', 'demo', 'old', 'task', '--from', 'orch/w');
    assert.match(r.out, /worker old is not ready/);
    assert.notEqual(rec('old').base, w.sh(w.repo, 'git rev-parse origin/main'));
    assert.equal(rec('old').parent, undefined);

    w.commitOnWorker('one.txt');
    r = w.orch('run', 'demo', 'kid', 'task', '--from', 'orch/w');
    assert.equal(rec('kid').parent, 'w');

    w.sh(w.repo, 'git checkout -q main && echo l > local.txt && git add local.txt && git commit -qm local && git remote set-url origin /nonexistent/origin.git');
    r = w.orch('run', 'demo', 'off', 'task');
    assert.match(r.out, /warning: git fetch origin failed in .*repo; using the local default branch, which may be stale/);
    assert.equal(rec('off').base, w.sh(w.repo, 'git rev-parse main'));
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
      { env: { ...process.env, ORCH_DIR: base, ORCH_SID: 'test', ORCH_QUEUE: 'off' } });
    const line = await new Promise<string>((done, fail) => {
      const t = setTimeout(() => fail(new Error('no OVERLAP line in 15 s')), 15_000);
      let out = '';
      c.stdout.on('data', d => { out += d; const m = out.match(/^OVERLAP .*$/m); if (m) { clearTimeout(t); done(m[0]); } });
    }).finally(() => c.kill());
    assert.match(line, /^OVERLAP error: check exited 1: .*JSON/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
