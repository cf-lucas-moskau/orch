// Rebuilds board.md and sessions.json from the live herdr snapshot and the hook feed, then prints the board.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBoard, renderBoard, type FeedEvent, type Repo, type Snapshot } from './board.ts';

const root = join(import.meta.dirname, '..');
const now = Date.now();

const snap: Snapshot = JSON.parse(execFileSync('herdr', ['api', 'snapshot'], { encoding: 'utf8' })).result.snapshot;

const day = (offset: number) => new Date(now - offset * 864e5).toLocaleDateString('sv-SE');
const feed: FeedEvent[] = [day(1), day(0)]
  .map(d => join(root, 'feed', `${d}.jsonl`))
  .filter(existsSync)
  .flatMap(f => readFileSync(f, 'utf8').split('\n'))
  .flatMap(l => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });

const git = (cwd: string, ...args: string[]) => {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const repos: Record<string, Repo> = {};
for (const cwd of new Set(snap.agents.map(a => a.cwd))) {
  const top = git(cwd, 'rev-parse', '--show-toplevel');
  if (top) repos[cwd] = { repo: top.split('/').at(-1)!, branch: git(cwd, 'branch', '--show-current') || 'detached' };
}

const rows = buildBoard(snap, feed, now, { selfCwd: root, repos });
const board = renderBoard(rows, now);
writeFileSync(join(root, 'board.md'), board);
// sessions.json doubles as the restore list after a reboot: what ran where, so `orch restore` can resume it.
writeFileSync(join(root, 'sessions.json'), JSON.stringify(
  Object.fromEntries(rows.map(r => [r.sid, { pane: r.pane, workspace: r.workspace, name: r.name, cwd: r.cwd, kind: r.kind }])), null, 2) + '\n');
process.stdout.write(board);
