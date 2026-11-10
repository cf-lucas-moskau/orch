import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LEADS, leadNotice, leadPrompt, leadUp, ownerOf, shows } from '../src/lead.ts';
import { decisionSkeleton, nextDecisionNumber, parseDecision } from '../src/brief.ts';

const repos: Record<string, string> = { 'idea-74': 'evrloot-next', 'netto-proto': 'netto' };
const owner = (line: string) => ownerOf(line, n => repos[n]);

test('idea, team and bridge lines belong to the Evrloot lead, whatever they name', () => {
  assert.equal(owner('IDEA I-12 new ann: bats drop more loot'), 'evrloot');
  assert.equal(owner('TEAM msg bob: orch, are you there?'), 'evrloot');
  assert.equal(owner('BRIDGE started (it was down)'), 'evrloot');
  assert.equal(owner('BRIDGE error: could not start: boom'), 'evrloot');
});

test('worker lines follow the worker repo', () => {
  assert.equal(owner('DONE worker idea-74 [w3:p1] 1234abcd: all green'), 'evrloot');
  assert.equal(owner('QUESTION worker idea-74 [w3:p1] -: (herdr: done) push it?'), 'evrloot');
  assert.equal(owner('BLOCKED worker idea-74 [w3:p1] 1234abcd: needs permission'), 'evrloot');
  assert.equal(owner('DONE worker netto-proto [w5:p1] 99: done'), 'orch');
  assert.equal(owner('DONE worker gone-one [w5:p1] 99: done'), 'orch', 'a worker no longer running is orch’s');
  assert.equal(owner('DONE tariffs-main [w4:p1] 99: finished'), 'orch', 'a plain session is orch’s');
  assert.equal(owner('QUEUE started on http://127.0.0.1:7390 (it was down)'), 'orch');
});

test('overlap lines follow the repo they name; an error about the check itself is orch’s', () => {
  assert.equal(owner('OVERLAP evrloot-next: idea-74 (later) and idea-66-4 both change 2 files: a, b'), 'evrloot');
  assert.equal(owner('OVERLAP error: evrloot-next: git fetch origin failed in ~/code/evrloot-next; skipped'), 'evrloot');
  assert.equal(owner('OVERLAP warning: evrloot-next: origin/HEAD is unknown'), 'evrloot');
  assert.equal(owner('OVERLAP tariffs: a (later) and b both change 1 file: x'), 'orch');
  assert.equal(owner('OVERLAP error: check exited 1: boom'), 'orch');
});

test('a lead watcher shows only its lines; orch shows a lead’s lines only while that lead is down', () => {
  const up = (l: string) => l === 'evrloot';
  assert.equal(shows('evrloot', 'evrloot', up), true);
  assert.equal(shows('orch', 'evrloot', up), false);
  assert.equal(shows('evrloot', undefined, up), false);
  assert.equal(shows('orch', undefined, up), true);
  assert.equal(shows('evrloot', undefined, () => false), true);
  assert.equal(shows('evrloot', 'evrloot', () => false), true, 'a lead keeps its lines even when its own beat is late');
});

test('a lead is up while its beat is under three minutes old', () => {
  const now = 1_000_000_000;
  assert.equal(leadUp(undefined, now), false);
  assert.equal(leadUp(now - 60_000, now), true);
  assert.equal(leadUp(now - 179_000, now), true);
  assert.equal(leadUp(now - 180_000, now), false);
});

test('LEAD down is said once for a started lead, LEAD up once when it is back, nothing for a stopped one', () => {
  const ev = LEADS.evrloot;
  const down = leadNotice(ev, false, true, false);
  assert.equal(down.line, 'LEAD evrloot down: orch handles its IDEA, TEAM, BRIDGE and evrloot-next worker lines until it is back (npm run -s orch -- lead start evrloot)');
  assert.equal(down.down, true);
  assert.deepEqual(leadNotice(ev, false, true, true), { down: true }, 'already said');
  assert.deepEqual(leadNotice(ev, true, true, true), { line: 'LEAD evrloot up: its lines go to lead-evrloot again', down: false });
  assert.deepEqual(leadNotice(ev, true, true, false), { down: false });
  assert.deepEqual(leadNotice(ev, false, false, false), { down: false }, 'stopped or never started');
});

test('a fresh lead reads its skill; a resumed one re-arms its watcher', () => {
  assert.equal(leadPrompt('evrloot', false), 'You are lead evrloot. Read .claude/skills/orch-lead/SKILL.md and follow it.');
  assert.match(leadPrompt('evrloot', true), /^orch restarted you as lead evrloot\. Re-arm your watcher .*ORCH_LEAD=evrloot/);
});

test('the next decision number comes after the highest file, gaps and READMEs ignored', () => {
  assert.equal(nextDecisionNumber(['README.md']), 1);
  assert.equal(nextDecisionNumber(['D-01.md', 'D-07.md', 'D-50.md', 'README.md', 'D-9.md.bak']), 51);
  const md = decisionSkeleton(51, 'Deploy idea-74?', 'lead-evrloot (w9, w9:p1)', '2026-11-10 09:00');
  assert.deepEqual(parseDecision(md), { id: 'D-51', question: 'Deploy idea-74?', session: 'lead-evrloot (w9, w9:p1)', status: 'open' });
  assert.match(decisionSkeleton(3, 'q', '', 't'), /^# D-03: q\n/);
});

// End to end: orch's and the lead's watcher on one feed, the way they run under Monitor.
const SRC = join(import.meta.dirname, '..', 'src');
const nodeArgs = ['--experimental-strip-types', '--no-warnings'];

function orchDir() {
  const root = mkdtempSync(join(tmpdir(), 'orch-lead-'));
  for (const d of ['feed', 'leads', 'decisions', 'ideas']) mkdirSync(join(root, d));
  writeFileSync(join(root, 'ideas', 'off'), '');
  // A config that does not parse: the bridge check prints a BRIDGE error every minute and never starts a bridge.
  writeFileSync(join(root, 'ideas', 'config.json'), '{');
  const worker = (name: string, repo: string, sid: string) => ({ name, repo, sid, pane: `${name}:p1`, worktree: join(root, name), status: 'running', branch: `orch/${name}`, task: 't', workspace: 'w', started: '' });
  writeFileSync(join(root, 'workers.json'), JSON.stringify([worker('idea-74', 'evrloot-next', 'evr00001'), worker('netto-proto', 'netto', 'net00001')]));
  writeFileSync(join(root, 'leads', 'evrloot.json'), JSON.stringify({ name: 'evrloot', workspace: 'w', pane: 'p', sid: 'lead0001', started: '', status: 'running' }));
  const feed = join(root, 'feed', `${new Date().toLocaleDateString('sv-SE')}.jsonl`);
  writeFileSync(feed, '');
  const stop = (sid: string, cwd: string, msg: string) => appendFileSync(feed, JSON.stringify({ ts: new Date().toISOString(), sid, event: 'Stop', cwd, prompt: '', msg }) + '\n');
  return { root, feed, stop };
}

const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

function watcher(root: string, env: Record<string, string>) {
  const p = spawn(process.execPath, [...nodeArgs, join(SRC, 'watch.ts')], { env: { ...process.env, ORCH_DIR: root, ORCH_QUEUE: 'off', ...env } });
  spawned.push(p);
  const lines: string[] = [];
  createInterface({ input: p.stdout }).on('line', l => lines.push(l));
  const until = async (pred: (ls: string[]) => boolean, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (pred(lines)) return;
    assert.fail(`timed out; got ${JSON.stringify(lines)}`);
  };
  return { p, lines, until };
}
const kill = (p: ChildProcess) => new Promise(r => { p.on('exit', r); p.kill(); });
const has = (re: RegExp) => (ls: string[]) => ls.some(l => re.test(l));

test('the watchers split one feed: Evrloot lines to the lead, the rest to orch; orch takes over when the lead goes down', async () => {
  const w = orchDir();
  const lead = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(readFileSync(join(w.root, 'leads', 'evrloot.beat'), 'utf8'), 'lead0001\n', 'the lead beats with its session id');
  const orch = watcher(w.root, { ORCH_SID: 'orch0001' });
  await new Promise(r => setTimeout(r, 1500));

  w.stop('evr00001', join(w.root, 'idea-74'), 'Done: arena wager works.');
  w.stop('net00001', join(w.root, 'netto-proto'), 'Done: excel unified.');
  w.stop('lead0001', w.root, 'Dispatched idea-74.');
  appendFileSync(w.feed, JSON.stringify({ ts: new Date().toISOString(), sid: 'bridge', event: 'Idea', cwd: '', prompt: '', msg: 'IDEA I-9 new ann: more bats' }) + '\n');
  await lead.until(has(/^IDEA I-9/));
  await orch.until(has(/^DONE worker netto-proto/));
  await new Promise(r => setTimeout(r, 1500));
  assert.deepEqual(lead.lines.filter(l => /^(DONE|IDEA)/.test(l)), ['DONE worker idea-74 [idea-74:p1] evr00001: Done: arena wager works.', 'IDEA I-9 new ann: more bats']);
  assert.deepEqual(orch.lines.filter(l => /^(DONE|IDEA|LEAD)/.test(l)), ['DONE worker netto-proto [netto-proto:p1] net00001: Done: excel unified.'],
    'orch drops Evrloot lines while the lead is up, and the lead’s own turns');
  // orch's own bridge check hands its line to the lead (the config here does not parse, so it is an error line).
  await lead.until(has(/^BRIDGE error: ideas\/config\.json: .*does not parse/));
  assert.equal(orch.lines.some(l => l.startsWith('BRIDGE')), false);

  await kill(orch.p);
  await kill(lead.p);
  const old = (Date.now() - 10 * 60_000) / 1000;
  utimesSync(join(w.root, 'leads', 'evrloot.beat'), old, old);
  const back = watcher(w.root, { ORCH_SID: 'orch0001' });
  await back.until(has(/^LEAD evrloot down: orch handles/));
  assert.equal(existsSync(join(w.root, 'leads', 'evrloot.down')), true);
  w.stop('evr00001', join(w.root, 'idea-74'), 'Done again.');
  await back.until(has(/^DONE worker idea-74 .*Done again\.$/));
  await back.until(has(/^BRIDGE error/));
  await kill(back.p);

  const again = watcher(w.root, { ORCH_SID: 'orch0001' });
  await again.until(has(/^BRIDGE error/));
  assert.equal(again.lines.some(l => l.startsWith('LEAD')), false, 'a re-armed watcher does not say LEAD down again');
  await kill(again.p);
});

test('lead and decision commands refuse bad input before touching herdr', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-lead-cmd-'));
  mkdirSync(join(root, 'decisions'));
  writeFileSync(join(root, 'decisions', 'D-07.md'), '# D-07: old\n');
  const orch = (...a: string[]) => spawnSync(process.execPath, [...nodeArgs, join(SRC, 'orch.ts'), ...a], { cwd: root, env: { ...process.env, ORCH_DIR: root }, encoding: 'utf8' });
  const bad = orch('lead', 'start', 'nope');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /usage: orch lead start\|stop\|status <evrloot>/);
  const made = orch('decision', 'new', 'Deploy', 'idea-74?', '--session', 'lead-evrloot (w9, w9:p1)');
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout.trim(), join(root, 'decisions', 'D-08.md'));
  assert.deepEqual(parseDecision(readFileSync(join(root, 'decisions', 'D-08.md'), 'utf8')), { id: 'D-08', question: 'Deploy idea-74?', session: 'lead-evrloot (w9, w9:p1)', status: 'open' });
  assert.equal(orch('decision', 'new', 'Second').stdout.trim(), join(root, 'decisions', 'D-09.md'));
  assert.match(readFileSync(join(root, 'log.md'), 'utf8'), /decision new D-08: Deploy idea-74\?/);
});
