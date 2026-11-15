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
