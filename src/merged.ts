// Whether a worker's work merged, for orch.ts (overlap, PR rounds) and the watcher's UNSHIPPED check. A squash merge
// leaves no trace in git history, so a merged worker is found by its PR.
import { spawnSync } from 'node:child_process';

// Head commits of the branch's merged PRs, or what gh said when it failed.
export function mergedHeads(path: string, branch: string): { heads: string[] } | { error: string } {
  const r = spawnSync('gh', ['pr', 'list', '--head', branch, '--state', 'merged', '--json', 'headRefOid', '-q', '.[].headRefOid'], { cwd: path, encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().split('\n')[0] };
  return { heads: r.stdout.trim().split('\n').filter(Boolean) };
}
// Merged when the branch's head is one a merged PR had, or older; a reused branch with new commits counts again.
export const isMerged = (cwd: string, ref: string, heads: string[]) =>
  heads.some(h => spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', ref, h]).status === 0);
