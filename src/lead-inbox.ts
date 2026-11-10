// IO glue: a lead's inbox, leads/<name>.inbox. orch's watcher appends every line of a lead that is up; whoever drains it
// (the lead's watcher, or orch when the lead is down or stopped) reads from a persisted offset, so a line written while
// the lead's watcher was between arms or dead is delivered on the next drain. Delivery is at least once: a crash between
// printing and saving the offset prints those lines again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The offset belongs to one file, named by inode; a fresh inbox after a trim starts at 0.
type Offset = { ino: number; off: number };

const paths = (root: string, name: string) => {
  const base = join(root, 'leads', `${name}.inbox`);
  return { inbox: base, draining: `${base}.draining`, offset: `${base}.offset` };
};

export function post(root: string, name: string, line: string) {
  mkdirSync(join(root, 'leads'), { recursive: true });
  appendFileSync(paths(root, name).inbox, line + '\n');
}

// Prints every unread line with emit. A fully read inbox is trimmed: renamed aside (appends from then on start a new
// file), its rest read, then removed.
export function drain(root: string, name: string, emit: (line: string) => void) {
  const p = paths(root, name);
  const load = (): Offset => { try { return JSON.parse(readFileSync(p.offset, 'utf8')); } catch { return { ino: 0, off: 0 }; } };
  const save = (o: Offset) => writeFileSync(p.offset, JSON.stringify(o) + '\n');
  // all: the file gets no more appends, so a last line without its newline counts too.
  const take = (file: string, all: boolean) => {
    const ino = statSync(file).ino, buf = readFileSync(file), o = load();
    const from = o.ino === ino && o.off <= buf.length ? o.off : 0;
    const end = all ? buf.length : buf.lastIndexOf(10) + 1;
    if (end > from) for (const l of buf.subarray(from, end).toString('utf8').split('\n')) if (l) emit(l);
    save({ ino, off: Math.max(end, from) });
    return Math.max(end, from) === buf.length && buf.length > 0;
  };
  const finish = () => { take(p.draining, true); save({ ino: 0, off: 0 }); rmSync(p.draining, { force: true }); };
  // A drain that died mid-trim left its file aside.
  if (existsSync(p.draining)) finish();
  if (!existsSync(p.inbox)) return;
  if (take(p.inbox, false)) { renameSync(p.inbox, p.draining); finish(); }
}
