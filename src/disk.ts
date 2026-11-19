// Thinning local Time Machine snapshots when the data volume runs low. Hourly local snapshots keep everything workers
// delete, so free space falls by tens of GB in hours. The watcher (src/watch.ts) does the IO; this decides.

// When the last thin started and the last DISK low line was said, in ms, 0 = never. Kept in disk.json so a watcher
// re-arm does not reset the rate limits.
export type DiskState = { thinned: number; lowSaid: number };
export const NEVER: DiskState = { thinned: 0, lowSaid: 0 };

export const CHECK_MS = 5 * 60_000;
export const THIN_MS = 10 * 60_000;
export const LOW_MS = 60 * 60_000;

// Only the boot volume's local snapshots, by purge amount and urgency 4; never a dated delete, never sudo.
export const THIN_ARGS = ['thinlocalsnapshots', '/', '999999999999', '4'];

export function parseDiskThin(text: string): number {
  const m = text.match(/disk thin[^\d]*(\d+)/i);
  return m ? Number(m[1]) : 30;
}

export const thinDue = (s: DiskState, now: number, freeGb: number, thresholdGb: number) =>
  freeGb < thresholdGb && now - s.thinned >= THIN_MS;

// The lines a finished thin prints and the state after it. A thin that freed under 1 GB says nothing: there was
// nothing left to thin, and repeating that every 10 minutes is noise. Still under the Disk floor: said once an hour,
// also after a thin that failed.
export function afterThin(s: DiskState, now: number, beforeGb: number, afterGb: number, floorGb: number): { state: DiskState; lines: string[] } {
  const lines: string[] = [];
  if (afterGb - beforeGb >= 1) lines.push(`DISK thinned local snapshots: ${beforeGb} -> ${afterGb} GB free`);
  let lowSaid = s.lowSaid;
  if (afterGb < floorGb && now - s.lowSaid >= LOW_MS) {
    lines.push(`DISK low: ${afterGb} GB free after thinning`);
    lowSaid = now;
  }
  return { state: { ...s, thinned: now, lowSaid }, lines };
}

// df -k <path>: the fourth column of the second line is the free space in KB.
export function parseDfFreeGb(out: string): number | undefined {
  const kb = Number(out.trim().split('\n')[1]?.split(/\s+/)[3]);
  return Number.isFinite(kb) ? Math.floor(kb / 1048576) : undefined;
}

const GB = 1048576;
const gb = (kb: number) => (kb / GB).toFixed(1);

// Whether an installed tree is what its lockfile says: npm's hidden lockfile (node_modules/.package-lock.json) lists
// what is installed. Every non-optional package of the lockfile is there, at the locked version, and nothing else is.
// evrloot-next's main checkout lacked happy-dom with an unchanged lockfile (2026-11-19), so the lockfile alone can lie.
type Packages = Record<string, { version?: string; optional?: boolean }>;
export function installMatches(lock: Packages, installed: Packages): boolean {
  const nm = (k: string) => k.includes('node_modules/');
  return Object.keys(lock).every(k => !nm(k) || lock[k].optional || installed[k])
    && Object.keys(installed).every(k => !nm(k) || lock[k]?.version === installed[k].version);
}

// sysctl vm.swapusage: "total = 10240.00M  used = 9363.94M  free = ...".
export function parseSwapGb(out: string): number | undefined {
  const m = out.match(/used = ([\d.]+)([MG])/);
  return m ? Number(m[1]) / (m[2] === 'M' ? 1024 : 1) : undefined;
}

// tmutil listlocalsnapshots /: a header, then one com.apple.* name per snapshot.
export const snapshotCount = (out: string) => out.split('\n').filter(l => l.startsWith('com.apple.')).length;

// saved/ holds what cleanup --keep copied, in <name>-YYYYMMDD-HHMM folders. Older than SAVED_DAYS is listed by
// orch saved --prune and deleted only with --yes. A folder without that stamp ages by its mtime.
export const SAVED_DAYS = 3;
export type SavedEntry = { name: string; mtimeMs: number };
export function savedAge(e: SavedEntry): number {
  const m = e.name.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : e.mtimeMs;
}
export const staleSaved = (es: SavedEntry[], now: number, days = SAVED_DAYS) =>
  es.filter(e => now - savedAge(e) > days * 86_400_000).map(e => e.name).sort();

// Watcher FYI lines on worker size: a running worktree past WORKTREE_GB of its own (clones left out) once per worker
// name, swap past SWAP_GB at most hourly. Kept in disk.json beside the thin state.
export const WORKTREE_GB = 1.5, SWAP_GB = 8;
export type SizeState = { bigSaid: string[]; swapSaid: number };
export function sizeLines(s: Partial<SizeState>, now: number, worktrees: { name: string; kb: number }[], swapGb?: number): { state: SizeState; lines: string[] } {
  const lines: string[] = [];
  const said = (s.bigSaid ?? []).filter(n => worktrees.some(w => w.name === n));
  for (const w of worktrees) {
    if (w.kb / GB <= WORKTREE_GB || said.includes(w.name)) continue;
    lines.push(`DISK worktree ${w.name} ${gb(w.kb)} GB`);
    said.push(w.name);
  }
  let swapSaid = s.swapSaid ?? 0;
  if (swapGb !== undefined && swapGb > SWAP_GB && now - swapSaid >= LOW_MS) {
    lines.push(`DISK swap ${swapGb.toFixed(1)} GB`);
    swapSaid = now;
  }
  return { state: { bigSaid: said, swapSaid }, lines };
}

// orch disk: one screen of what holds the disk. Sizes in KB; a worktree's is its own, clones left out.
export type DiskReport = {
  freeGb?: number; swapGb?: number; snapshots: number;
  worktrees: { name: string; repo: string; kb: number }[];
  saved: { kb: number; folders: number; stale: number };
  dockerKb?: number; scratchKb?: number;
};
export function renderDisk(r: DiskReport): string {
  const top = [
    ...r.worktrees.map(w => ({ kb: w.kb, what: `worktree ${w.name}` })),
    { kb: r.saved.kb, what: 'saved/' },
    ...r.dockerKb === undefined ? [] : [{ kb: r.dockerKb, what: 'Docker.raw' }],
    ...r.scratchKb === undefined ? [] : [{ kb: r.scratchKb, what: 'Claude scratch (/private/tmp/claude-*)' }],
    ...r.swapGb === undefined ? [] : [{ kb: r.swapGb * GB, what: 'swap' }],
  ].sort((a, b) => b.kb - a.kb).slice(0, 5);
  const row = (kb: number, what: string) => `${gb(kb).padStart(6)} GB  ${what}`;
  return [
    `free ${r.freeGb ?? '?'} GB, swap ${r.swapGb === undefined ? '?' : r.swapGb.toFixed(1)} GB used, ${r.snapshots} local snapshot${r.snapshots === 1 ? '' : 's'}`,
    '',
    `running worktrees (own bytes, clones left out):`,
    ...r.worktrees.length ? [...r.worktrees].sort((a, b) => b.kb - a.kb).map(w => row(w.kb, `${w.name} (${w.repo})`)) : ['  none'],
    '',
    row(r.saved.kb, `saved/, ${r.saved.folders} folders, ${r.saved.stale} older than ${SAVED_DAYS} days${r.saved.stale ? ' (orch saved --prune)' : ''}`),
    row(r.dockerKb ?? 0, r.dockerKb === undefined ? 'Docker.raw not found' : 'Docker.raw'),
    '',
    'top 5:',
    ...top.map(t => row(t.kb, t.what)),
  ].join('\n');
}
