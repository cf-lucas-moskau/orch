// Disk measurements shared by orch disk and the watcher (src/disk.ts decides what they mean).
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { homedir } from 'node:os';
import { installMatches, parseSwapGb } from './disk.ts';

const out = (cmd: string, args: string[], timeout = 120_000) => new Promise<string>(res =>
  execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 1 << 24 }, (_e, stdout) => res(stdout ?? '')));

// Allocated KB, as du counts them: an APFS clone counts in full, which is why ownKb subtracts the cloned folders.
export const duKb = async (path: string) => Number((await out('du', ['-sk', path])).split('\t')[0]) || 0;

export async function ownKb(worktree: string, cloned: string[] = []): Promise<number> {
  const [all, ...shared] = await Promise.all([worktree, ...cloned.map(c => join(worktree, c))].map(duKb));
  return Math.max(0, all - shared.reduce((a, b) => a + b, 0));
}

export const swapGb = async () => parseSwapGb(await out('sysctl', ['vm.swapusage'], 10_000));

const bytes = (f: string) => { try { return readFileSync(f); } catch { return undefined; } };
const packages = (buf?: Buffer) => { try { return JSON.parse(String(buf)).packages ?? undefined; } catch { return undefined; } };

// Why a node_modules clone path must not be cloned, or '' when it may: the lockfile beside it (a nested one when either
// side has it, else the root one) must be the same bytes in both, and main's install must match it (installMatches).
function installWhy(main: string, wt: string, c: string): string {
  const parent = dirname(c);
  const dir = parent !== '.' && [main, wt].some(r => existsSync(join(r, parent, 'package-lock.json'))) ? parent : '';
  const lock = join(dir, 'package-lock.json');
  const a = bytes(join(main, lock)), b = bytes(join(wt, lock));
  if (!a || !b || !a.equals(b)) return `${lock} differs from the main checkout`;
  const installed = packages(bytes(join(main, dir, 'node_modules', '.package-lock.json')));
  return installed && installMatches(packages(a) ?? {}, installed) ? '' : `the main checkout's ${join(dir, 'node_modules')} does not match its ${lock}`;
}

export type CloneResult = { done: string[]; skipped: { path: string; why: string }[]; failed: string[] };

// The repo's clone paths (projects.md) copied from the main checkout as APFS clones (cp -c): copy-on-write, so they
// cost no bytes until a worker writes to them. A destination must resolve inside the worktree, symlinks followed, or it
// is refused. Never throws: a worker whose clone failed still starts and gets its record.
export function cloneFromMain(main: string, wt: string, clone: string[]): CloneResult {
  const r: CloneResult = { done: [], skipped: [], failed: [] };
  let root: string;
  try { root = realpathSync(wt); } catch { return { ...r, failed: [...clone] }; }
  const inside = (p: string) => p === root || p.startsWith(`${root}/`);
  const resolvedInside = (p: string) => {
    let d = p;
    while (!existsSync(d)) d = dirname(d);
    return inside(realpathSync(d));
  };
  for (const c of clone) {
    const skip = (why: string) => r.skipped.push({ path: c, why });
    try {
      const rel = normalize(c).replace(/\/+$/, '');
      if (!rel || rel === '.' || isAbsolute(rel) || rel === '..' || rel.startsWith('../')) { skip('not a path inside the repo'); continue; }
      const src = join(main, rel), dst = join(root, rel);
      if (basename(rel) === 'node_modules') {
        const why = installWhy(main, root, rel);
        if (why) { skip(why); continue; }
      }
      if (!existsSync(src)) { skip('not in the main checkout'); continue; }
      if (lstatSync(dst, { throwIfNoEntry: false })) { skip('already in the worktree'); continue; }
      if (!resolvedInside(dirname(dst))) { skip('its folder leads out of the worktree'); continue; }
      mkdirSync(dirname(dst), { recursive: true });
      if (!inside(realpathSync(dirname(dst)))) { skip('its folder leads out of the worktree'); continue; }
      if (spawnSync('cp', ['-cR', src, dst], { timeout: 5 * 60_000 }).status === 0) r.done.push(c);
      else {
        // A half clone is a broken install; it is orch's own copy of seconds ago, inside the worktree (checked above).
        rmSync(dst, { recursive: true, force: true });
        r.failed.push(c);
      }
    } catch { r.failed.push(c); }
  }
  return r;
}

export const DOCKER_RAW = join(homedir(), 'Library/Containers/com.docker.docker/Data/vms/0/data/Docker.raw');
