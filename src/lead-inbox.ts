// IO glue: a lead's inbox, leads/<name>.inbox. orch's watcher appends every line of a lead that is up; whoever drains it
// (the lead's watcher, or orch when the lead is down or stopped) prints it and removes it under one lock, so the file
// itself is the read position: what is in it is unread, and a line written while the lead's watcher was between arms or
// dead is delivered on the next drain. Delivery is at least once: a crash between printing and removing prints again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const paths = (root: string, name: string) => ({ inbox: join(root, 'leads', `${name}.inbox`) });

// One holder at a time, across processes: a post never lands in a file a drain is trimming, and two drains (the lead's
// and orch's takeover) never read the same lines. mkdir is atomic; a lock older than STALE_MS was left by a holder that
// died, and is taken over.
const STALE_MS = 10_000;
function locked<T>(root: string, name: string, fn: () => T): T {
  mkdirSync(join(root, 'leads'), { recursive: true });
  const lock = `${paths(root, name).inbox}.lock`;
  for (let waited = 0; ; waited += 10) {
    try { mkdirSync(lock); break; }
    catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true }); } catch {}
      if (waited > 2 * STALE_MS) throw new Error(`inbox lock ${lock} held for over ${2 * STALE_MS / 1000} s`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function post(root: string, name: string, line: string) {
  locked(root, name, () => appendFileSync(paths(root, name).inbox, line + '\n'));
}

// Prints every unread line with emit, then removes the inbox.
export function drain(root: string, name: string, emit: (line: string) => void) {
  locked(root, name, () => drainLocked(root, name, emit));
}

function drainLocked(root: string, name: string, emit: (line: string) => void) {
  const { inbox } = paths(root, name);
  if (!existsSync(inbox)) return;
  for (const l of readFileSync(inbox, 'utf8').split('\n')) if (l) emit(l);
  rmSync(inbox);
}
