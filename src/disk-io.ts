// Disk measurements shared by orch disk and the watcher (src/disk.ts decides what they mean).
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { clonePaths, installMatches, parseSwapGb } from './disk.ts';

const out = (cmd: string, args: string[], timeout = 120_000) => new Promise<string>(res =>
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 1 << 24 }, (_e, stdout) => res(stdout ?? '')));

// Allocated KB, as du counts them: an APFS clone counts in full, which is why ownKb subtracts the cloned folders.
export const duKb = async (path: string) => Number((await out('du', ['-sk', path])).split('\t')[0]) || 0;

export async function ownKb(worktree: string, cloned: string[] = []): Promise<number> {
  const [all, ...shared] = await Promise.all([worktree, ...cloned.map(c => join(worktree, c))].map(duKb));
  return Math.max(0, all - shared.reduce((a, b) => a + b, 0));
}

export const swapGb = async () => parseSwapGb(await out('sysctl', ['vm.swapusage'], 10_000));

// The repo's clone paths (projects.md) copied from the main checkout as APFS clones (cp -c): copy-on-write, so they
// cost no bytes until a worker writes to them. Paths already in the worktree or missing in the main checkout are skipped.
// node_modules only when the worktree's lockfile is the main checkout's and main's install matches it (installMatches);
// why says which failed.
export function cloneFromMain(main: string, wt: string, clone: string[]) {
  const bytes = (f: string) => { try { return readFileSync(f); } catch { return undefined; } };
  const a = bytes(join(main, 'package-lock.json')), b = bytes(join(wt, 'package-lock.json'));
  const parsed = (buf?: Buffer) => { try { return JSON.parse(String(buf)).packages ?? {}; } catch { return undefined; } };
  const installed = parsed(bytes(join(main, 'node_modules', '.package-lock.json')));
  const why = !a || !b || !a.equals(b) ? 'package-lock.json differs from the main checkout'
    : !installed || !installMatches(parsed(a), installed) ? 'the main checkout\'s node_modules does not match its package-lock.json' : '';
  const done: string[] = [], failed: string[] = [];
  for (const c of clonePaths(clone, !why)) {
    const src = join(main, c), dst = join(wt, c);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    if (spawnSync('cp', ['-cR', src, dst], { timeout: 5 * 60_000 }).status === 0) done.push(c);
    else {
      // A half clone is a broken install; it is orch's own copy of seconds ago.
      rmSync(dst, { recursive: true, force: true });
      failed.push(c);
    }
  }
  return { done, failed, skipped: clone.filter(c => !done.includes(c)), why };
}

export const DOCKER_RAW = join(homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
