// IO glue: a lead's inbox, one append-only file per day, leads/<name>.inbox-<YYYY-MM-DD>. orch's watcher appends each
// line of a lead that is up in one O_APPEND write, which lands whole. Whoever reads it (the lead's watcher, or orch when
// the lead is down or stopped) goes forward from a byte offset per file kept in leads/<name>.offsets.json, so a line
// written while the lead's watcher was between arms or dead comes on the next read. Nothing is trimmed while it runs;
// the lead's watcher deletes files older than two days when it starts. A crash between printing and saving the offset
// prints those lines again: at least once, never lost.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Beat } from './lead.ts';

const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE');
const dir = (root: string) => join(root, 'leads');
const prefix = (name: string) => `${name}.inbox-`;
const files = (root: string, name: string) =>
  existsSync(dir(root)) ? readdirSync(dir(root)).filter(f => f.startsWith(prefix(name)) && /^\d{4}-\d{2}-\d{2}$/.test(f.slice(prefix(name).length))).sort() : [];
const offsetsFile = (root: string, name: string) => join(dir(root), `${name}.offsets.json`);

export function post(root: string, name: string, line: string, now = Date.now()) {
  mkdirSync(dir(root), { recursive: true });
  appendFileSync(join(dir(root), prefix(name) + dayOf(now)), line + '\n');
}

// Prints every line past the saved offsets with emit, oldest file first. A line still being written waits.
export function read(root: string, name: string, emit: (line: string) => void) {
  const all = files(root, name);
  if (!all.length) return;
  let offsets: Record<string, number> = {};
  try { offsets = JSON.parse(readFileSync(offsetsFile(root, name), 'utf8')); } catch {}
  const save = () => {
    const tmp = `${offsetsFile(root, name)}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(all.map(f => [f, offsets[f] ?? 0]))) + '\n');
    renameSync(tmp, offsetsFile(root, name));
  };
  for (const f of all) {
    const buf = readFileSync(join(dir(root), f)), from = offsets[f] ?? 0, end = buf.lastIndexOf(10) + 1;
    if (end <= from) continue;
    for (const l of buf.subarray(from, end).toString('utf8').split('\n')) if (l) emit(l);
    offsets[f] = end;
    save();
  }
}

// The beat a lead's watcher writes (src/lead.ts): when, and from which session.
export function readBeat(root: string, name: string): Beat | undefined {
  const p = join(dir(root), `${name}.beat`);
  try { return { ms: statSync(p).mtimeMs, sid: readFileSync(p, 'utf8').trim() }; } catch { return undefined; }
}

// Deletes inbox files from before the day before yesterday.
export function prune(root: string, name: string, now = Date.now()) {
  const keep = dayOf(now - 2 * 864e5);
  for (const f of files(root, name)) if (f.slice(prefix(name).length) < keep) rmSync(join(dir(root), f), { force: true });
}
