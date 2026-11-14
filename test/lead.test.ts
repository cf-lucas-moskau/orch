import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { LEADS, leadNotice, leadPrompt, leadUp, ownerOf, parsePane, shows, type LeadPane } from '../src/lead.ts';
import { decisionSkeleton, nextDecisionNumber, parseDecision } from '../src/brief.ts';
import { post, prune, read } from '../src/lead-inbox.ts';

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

test('a lead is up while a fresh beat comes from the session its running record names', () => {
  const now = 1_000_000_000;
  const rec = { sid: 'lead0001', status: 'running' as const };
  assert.equal(leadUp(undefined, rec, now), false);
  assert.equal(leadUp({ ms: now - 60_000, sid: 'lead0001' }, rec, now), true);
  assert.equal(leadUp({ ms: now - 179_000, sid: 'lead0001' }, rec, now), true);
  assert.equal(leadUp({ ms: now - 180_000, sid: 'lead0001' }, rec, now), false, 'stale');
  assert.equal(leadUp({ ms: now, sid: 'other' }, rec, now), false, 'a watcher of another session');
  assert.equal(leadUp({ ms: now, sid: 'lead0001' }, { ...rec, status: 'stopped' }, now), false, 'a stopped lead');
  assert.equal(leadUp({ ms: now, sid: 'lead0001' }, undefined, now), false, 'never started');
  assert.equal(leadUp({ ms: now, sid: '' }, { ...rec, sid: '' }, now), false, 'no session id on either side');
});

test('a stale beat counts as up while the lead works, for up to 15 minutes', () => {
  const now = 1_000_000_000;
  const rec = { sid: 'lead0001', status: 'running' as const };
  const beat = (min: number) => ({ ms: now - min * 60_000, sid: 'lead0001' });
  let asked = 0;
  const herdr = (p: LeadPane) => () => { asked++; return p; };
  const as = (status: string, sid = 'lead0001') => herdr({ status, sid });
  assert.equal(leadUp(beat(1), rec, now, as('idle')), true, 'fresh beat');
  assert.equal(asked, 0, 'herdr is not asked for a fresh beat');
  assert.equal(leadUp(beat(5), rec, now, as('working')), true, 'stale beat, working');
  assert.equal(leadUp(beat(14.9), rec, now, as('working')), true, 'just under 15 min, working');
  assert.equal(leadUp(beat(3), rec, now, as('idle')), false, 'stale beat, idle');
  assert.equal(leadUp(beat(5), rec, now, as('done')), false, 'stale beat, done');
  assert.equal(leadUp(beat(5), rec, now, as('blocked')), false, 'stale beat, blocked');
  assert.equal(leadUp(beat(5), rec, now, herdr('gone')), false, 'stale beat, process gone');
  assert.equal(leadUp(beat(5), rec, now), false, 'stale beat, no herdr status given');
  assert.equal(leadUp(beat(5), rec, now, as('working', 'someone-else')), false, 'another session works in that pane');
  assert.equal(leadUp(beat(5), rec, now, herdr('unknown')), true, 'herdr failed: up within the grace');
  assert.equal(leadUp(beat(16), rec, now, herdr('unknown')), false, '16 min stale, herdr failed');
  assert.equal(leadUp(beat(16), rec, now, as('working')), false, '16 min stale, working');
  assert.equal(leadUp({ ms: now - 5 * 60_000, sid: 'other' }, rec, now, as('working')), false, 'stale beat of another session');
});

test('parsePane reads herdr agent get: gone only on agent_not_found, unknown on anything unreadable', () => {
  assert.deepEqual(parsePane('{"result":{"agent":{"agent_status":"working","agent_session":{"value":"lead0001"}}}}'), { status: 'working', sid: 'lead0001' });
  assert.deepEqual(parsePane('{"result":{"agent":{"agent_status":"idle"}}}'), { status: 'idle', sid: '' });
  assert.equal(parsePane('{"error":{"code":"agent_not_found","message":"not found"}}'), 'gone');
  assert.equal(parsePane('{"error":{"code":"timeout"}}'), 'unknown');
  assert.equal(parsePane(''), 'unknown', 'timed out or killed: no output');
  assert.equal(parsePane('herdr: socket error'), 'unknown');
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

// A fake herdr first on PATH: every herdr call in these tests lands here, so no test can touch a real pane or workspace.
// It records each call and answers agent list and workspace get from what the test set.
// screen: what agent read shows, an empty input box by default.
function herdrStub(o: { agents?: object[]; label?: string; screen?: string; sid?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-stub-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ result: { agents: o.agents ?? [] } }));
  writeFileSync(join(dir, 'screen'), (o.screen ?? 'done.\n❯ \n────') + '\n');
  writeFileSync(join(dir, 'herdr'), `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1 $2" in
  "agent list") cat '${dir}/agents.json' ;;
  "agent read") cat '${dir}/screen' ;;
  "workspace get") echo '{"result":{"workspace":{"label":"${o.label ?? ''}"}}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w20"},"root_pane":{"pane_id":"w20:p1"}}}' ;;
  "agent get") echo '{"result":{"agent":{"agent_status":"idle","state_change_seq":1${o.sid ? `,"agent_session":{"value":"${o.sid}"}` : ""}}}}' ;;
  "agent start"|"agent prompt") echo '{"error":{"code":"stub","message":"stub"}}' ;;
  *) echo '{"result":{"type":"ok"}}' ;;
esac
`, { mode: 0o755 });
  return {
    env: { PATH: `${dir}:${process.env.PATH}`, ORCH_HERDR_VERSION: '0.9.5' },
    calls: () => existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n') : [],
  };
}
const orchCmd = (root: string, env: Record<string, string>, ...a: string[]) =>
  spawnSync(process.execPath, [...nodeArgs, join(SRC, 'orch.ts'), ...a], { cwd: root, env: { ...process.env, ORCH_DIR: root, ...env }, encoding: 'utf8', timeout: 60_000 });

const spawned: ChildProcess[] = [];
after(() => { for (const p of spawned) p.kill(); });

function watcher(root: string, env: Record<string, string>) {
  const p = spawn(process.execPath, [...nodeArgs, join(SRC, 'watch.ts')], { env: { ...process.env, ORCH_DIR: root, ORCH_QUEUE: 'off', ...herdrStub().env, ...env } });
  spawned.push(p);
  const lines: string[] = [];
  let probed = false;
  // Probe lines (see ready) are kept out of lines, so assertions see only what the test caused.
  createInterface({ input: p.stdout }).on('line', l => { if (l.includes('watcher-probe')) probed = true; else lines.push(l); });
  const until = async (pred: (ls: string[]) => boolean, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 100))) if (pred(lines)) return;
    assert.fail(`timed out; got ${JSON.stringify(lines)}`);
  };
  // Ready: a lead's watcher once its beat carries its session id; orch's once it prints a feed line, so nothing the test
  // writes next can land before its tail runs, however loaded the machine is.
  const ready = async () => {
    const feed = join(root, 'feed', `${new Date().toLocaleDateString('sv-SE')}.jsonl`);
    for (const end = Date.now() + 15_000; Date.now() < end; await new Promise(r => setTimeout(r, 200))) {
      if (env.ORCH_LEAD) { try { if (readFileSync(join(root, 'leads', `${env.ORCH_LEAD}.beat`), 'utf8').trim() === env.ORCH_SID) return; } catch {} continue; }
      if (probed) return;
      appendFileSync(feed, JSON.stringify({ ts: new Date().toISOString(), sid: 'probe000', event: 'Stop', cwd: '/probe', prompt: '', msg: 'watcher-probe' }) + '\n');
    }
    assert.fail('watcher never became ready');
  };
  return { p, lines, until, ready };
}
const kill = (p: ChildProcess) => new Promise(r => { p.on('exit', r); p.kill(); });
const has = (re: RegExp) => (ls: string[]) => ls.some(l => re.test(l));

test('the watchers split one feed: Evrloot lines to the lead, the rest to orch', async () => {
  const w = orchDir();
  const lead = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await lead.ready();
  assert.equal(readFileSync(join(w.root, 'leads', 'evrloot.beat'), 'utf8'), 'lead0001\n', 'the lead beats with its session id');
  const orch = watcher(w.root, { ORCH_SID: 'orch0001' });
  await orch.ready();

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
});

const stale = (root: string) => { const old = (Date.now() - 10 * 60_000) / 1000; utimesSync(join(root, 'leads', 'evrloot.beat'), old, old); };
const today = () => new Date().toLocaleDateString('sv-SE');
const inboxFile = (root: string, day = today()) => join(root, 'leads', `evrloot.inbox-${day}`);
const inboxHas = (root: string, re: RegExp) => async () => {
  for (const end = Date.now() + 8000; Date.now() < end; await new Promise(r => setTimeout(r, 100)))
    if (existsSync(inboxFile(root)) && re.test(readFileSync(inboxFile(root), 'utf8'))) return;
  assert.fail('never reached the inbox');
};

test('a worker DONE that lands while the lead watcher is between arms reaches it on re-arm, once', async () => {
  const w = orchDir();
  const lead = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await lead.ready();
  const orch = watcher(w.root, { ORCH_SID: 'orch0001' });
  await orch.ready();
  await kill(lead.p);
  w.stop('evr00001', join(w.root, 'idea-74'), 'Done between arms.');
  await inboxHas(w.root, /Done between arms\./)();
  const rearmed = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await rearmed.until(has(/Done between arms\.$/));
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(rearmed.lines.filter(l => /Done between arms/.test(l)).length, 1);
  assert.equal(orch.lines.some(l => /Done between arms/.test(l)), false, 'orch never prints it while the lead is up');
  await kill(rearmed.p);
  const third = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(third.lines.some(l => /Done between arms/.test(l)), false, 'a read line is not delivered again');
  await kill(third.p);
  await kill(orch.p);
});

test('a worker DONE that lands just before the lead dies reaches orch when it takes over, with the waiting ideas, once', async () => {
  const w = orchDir();
  writeFileSync(join(w.root, 'ideas', 'I-3.json'), JSON.stringify({ id: 'I-3', author: { id: 'u1', name: 'ann' }, text: 'more bats', state: 'talk', needsOrch: 'new', thread: 't3', messages: [] }));
  const lead = watcher(w.root, { ORCH_SID: 'lead0001', ORCH_LEAD: 'evrloot' });
  await lead.until(has(/^IDEA I-3 new ann: more bats$/));
  const orch = watcher(w.root, { ORCH_SID: 'orch0001', ORCH_LEAD_CHECK_MS: '300' });
  await orch.ready();
  assert.equal(orch.lines.some(l => l.startsWith('IDEA')), false, 'the lead replays its own ideas');
  appendFileSync(w.feed, JSON.stringify({ ts: new Date().toISOString(), sid: 'bridge', event: 'Idea', cwd: '', prompt: '', msg: 'IDEA I-3 new ann: more bats' }) + '\n');
  await inboxHas(w.root, /IDEA I-3/)();
  await kill(lead.p);
  w.stop('evr00001', join(w.root, 'idea-74'), 'Done before the crash.');
  await inboxHas(w.root, /Done before the crash\./)();
  stale(w.root);
  await orch.until(has(/Done before the crash\.$/));
  await new Promise(r => setTimeout(r, 1000));
  assert.deepEqual(orch.lines.filter(l => /^(LEAD|IDEA|DONE worker idea)/.test(l)), [
    'LEAD evrloot down: orch handles its IDEA, TEAM, BRIDGE and evrloot-next worker lines until it is back (npm run -s orch -- lead start evrloot)',
    'IDEA I-3 new ann: more bats',
    'DONE worker idea-74 [idea-74:p1] evr00001: Done before the crash.',
  ]);
  w.stop('evr00001', join(w.root, 'idea-74'), 'Done while down.');
  await orch.until(has(/Done while down\.$/));
  await kill(orch.p);

  const again = watcher(w.root, { ORCH_SID: 'orch0001' });
  await again.until(has(/^BRIDGE error/));
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(again.lines.filter(l => /^(LEAD|IDEA|DONE)/.test(l)), ['IDEA I-3 new ann: more bats'], 'a re-armed orch watcher replays once and says no second LEAD down');
  await kill(again.p);
});

test('orch starting with the lead already down says LEAD down and replays each waiting idea once', async () => {
  const w = orchDir();
  writeFileSync(join(w.root, 'ideas', 'I-3.json'), JSON.stringify({ id: 'I-3', author: { id: 'u1', name: 'ann' }, text: 'more bats', state: 'talk', needsOrch: 'new', thread: 't3', messages: [] }));
  writeFileSync(inboxFile(w.root), 'IDEA I-3 new ann: more bats\nDONE worker idea-74 [idea-74:p1] evr00001: left over\n');
  const orch = watcher(w.root, { ORCH_SID: 'orch0001' });
  await orch.until(has(/left over$/));
  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(orch.lines.filter(l => /^(LEAD|IDEA|DONE)/.test(l)), [
    'IDEA I-3 new ann: more bats',
    'LEAD evrloot down: orch handles its IDEA, TEAM, BRIDGE and evrloot-next worker lines until it is back (npm run -s orch -- lead start evrloot)',
    'DONE worker idea-74 [idea-74:p1] evr00001: left over',
  ]);
  await kill(orch.p);
});

test('the inbox is read forward from a saved offset per day file; a half-written line waits; old days are pruned', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-inbox-'));
  const got: string[] = [];
  const take = () => { got.length = 0; read(root, 'evrloot', l => got.push(l)); return [...got]; };
  const day = 864e5, now = Date.now();
  assert.deepEqual(take(), [], 'no inbox yet');
  post(root, 'evrloot', 'old', now - 3 * day);
  post(root, 'evrloot', 'A', now - day);
  post(root, 'evrloot', 'B');
  appendFileSync(inboxFile(root), 'half');
  assert.deepEqual(take(), ['old', 'A', 'B'], 'oldest day first');
  assert.deepEqual(take(), [], 'a read line is not delivered again');
  appendFileSync(inboxFile(root), ' done\n');
  post(root, 'evrloot', 'C');
  assert.deepEqual(take(), ['half done', 'C']);
  assert.equal(readFileSync(inboxFile(root), 'utf8'), 'B\nhalf done\nC\n', 'nothing is trimmed while it runs');
  const old4 = inboxFile(root, new Date(now - 4 * day).toLocaleDateString('sv-SE'));
  post(root, 'evrloot', 'late', now - 4 * day);
  prune(root, 'evrloot');
  assert.equal(existsSync(inboxFile(root, new Date(now - 3 * day).toLocaleDateString('sv-SE'))), false, 'three days old and read: pruned');
  assert.equal(existsSync(old4), true, 'an old file with an unread line is kept');
  assert.equal(existsSync(inboxFile(root, new Date(now - day).toLocaleDateString('sv-SE'))), true);
  post(root, 'evrloot', 'D');
  assert.deepEqual(take(), ['late', 'D'], 'offsets survive a prune');
  prune(root, 'evrloot');
  assert.equal(existsSync(old4), false, 'read now: pruned');
});

test('posts from several processes and a reader running at the same time deliver every line exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-inbox-race-'));
  const inbox = join(SRC, 'lead-inbox.ts');
  const run = (code: string) => new Promise<string>((res, rej) => {
    const p = spawn(process.execPath, [...nodeArgs, '--input-type=module', '-e', code], { encoding: 'utf8' } as any);
    let out = '';
    p.stdout!.on('data', d => { out += d; });
    p.stderr!.on('data', d => { out += d; });
    p.on('exit', c => c === 0 ? res(out) : rej(new Error(out)));
  });
  const poster = (k: number) => run(`import { post } from ${JSON.stringify(inbox)}; for (let i = 0; i < 300; i++) post(${JSON.stringify(root)}, 'evrloot', 'p${k} ' + i);`);
  const reader = run(`import { read } from ${JSON.stringify(inbox)};
    const end = Date.now() + 3000; while (Date.now() < end) read(${JSON.stringify(root)}, 'evrloot', l => console.log(l));`);
  const [, , , drained] = await Promise.all([poster(1), poster(2), poster(3), reader]);
  const got = drained.split('\n').filter(Boolean);
  read(root, 'evrloot', l => got.push(l));
  assert.equal(got.length, 900);
  assert.equal(new Set(got).size, 900);
});

test('lead stop marks the lead down at once and prints what it left: waiting ideas, then its unread inbox', () => {
  const w = orchDir();
  writeFileSync(join(w.root, 'ideas', 'I-3.json'), JSON.stringify({ id: 'I-3', author: { id: 'u1', name: 'ann' }, text: 'more bats', state: 'talk', needsOrch: 'new', thread: 't3', messages: [] }));
  writeFileSync(join(w.root, 'leads', 'evrloot.beat'), 'lead0001\n');
  writeFileSync(inboxFile(w.root), 'IDEA I-3 new ann: more bats\nDONE worker idea-74 [idea-74:p1] evr00001: unread\n');
  const h = herdrStub({ agents: [{ name: 'lead-evrloot', pane_id: 'w9:p1', workspace_id: 'w9', agent_status: 'idle', agent_session: { value: 'lead0001' } }], label: 'lead-evrloot' });
  const r = orchCmd(w.root, h.env, 'lead', 'stop', 'evrloot');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    "lead-evrloot stopped; orch's watcher handles its lines. Waiting on orch now:",
    'IDEA I-3 new ann: more bats',
    'DONE worker idea-74 [idea-74:p1] evr00001: unread',
  ]);
  assert.equal(existsSync(join(w.root, 'leads', 'evrloot.beat')), false);
  assert.equal(JSON.parse(readFileSync(join(w.root, 'leads', 'evrloot.json'), 'utf8')).status, 'stopped');
  assert.deepEqual(h.calls(), ['agent list', 'workspace get w9', 'workspace close w9']);
});

test('lead stop and start never close a workspace that is not the lead’s (herdr reuses ids after a restart)', () => {
  const w = orchDir();
  const h = herdrStub({ agents: [], label: 'orch' });
  writeFileSync(join(w.root, 'leads', 'evrloot.json'), JSON.stringify({ name: 'evrloot', workspace: 'w9', pane: 'w9:p1', sid: 'lead0001', started: '', status: 'running' }));
  const stop = orchCmd(w.root, h.env, 'lead', 'stop', 'evrloot');
  assert.equal(stop.status, 0, stop.stderr);
  assert.match(stop.stderr, /left workspace w9 open: it is orch, not lead-evrloot/);
  orchCmd(w.root, h.env, 'lead', 'start', 'evrloot');
  assert.equal(h.calls().filter(c => c.startsWith('workspace close')).length, 0);
  assert.ok(h.calls().includes('workspace create --cwd ' + w.root + ' --label lead-evrloot --no-focus'), h.calls().join('\n'));
});

test('lead start on a live lead takes its ids from herdr and re-arms a watcher that stopped beating', () => {
  const w = orchDir();
  const h = herdrStub({ agents: [{ name: 'lead-evrloot', pane_id: 'w7:p2', workspace_id: 'w7', agent_status: 'idle', agent_session: { value: 'lead0002' } }], label: 'lead-evrloot' });
  writeFileSync(join(w.root, 'leads', 'evrloot.beat'), 'lead0002\n');
  const fresh = orchCmd(w.root, h.env, 'lead', 'start', 'evrloot');
  assert.equal(fresh.stdout.trim(), 'lead-evrloot already runs in w7:p2');
  const rec = JSON.parse(readFileSync(join(w.root, 'leads', 'evrloot.json'), 'utf8'));
  assert.deepEqual([rec.workspace, rec.pane, rec.sid, rec.status], ['w7', 'w7:p2', 'lead0002', 'running']);
  assert.equal(h.calls().some(c => c.startsWith('agent prompt')), false);
  stale(w.root);
  orchCmd(w.root, h.env, 'lead', 'start', 'evrloot');
  assert.ok(h.calls().some(c => c.startsWith('agent prompt lead-evrloot orch restarted you as lead evrloot. Re-arm your watcher')), h.calls().join('\n'));
  assert.equal(h.calls().some(c => /^(workspace (create|close)|agent start)/.test(c)), false);
});

test('orch’s watcher fills in a running lead’s empty session id from herdr, and its beat then counts', async () => {
  const w = orchDir();
  writeFileSync(join(w.root, 'leads', 'evrloot.json'), JSON.stringify({ name: 'evrloot', workspace: 'w', pane: 'p', sid: '', started: '', status: 'running' }));
  writeFileSync(join(w.root, 'leads', 'evrloot.beat'), 'lead0009\n');
  const orch = watcher(w.root, { ORCH_SID: 'orch0001', ...herdrStub({ sid: 'lead0009' }).env });
  await orch.until(() => JSON.parse(readFileSync(join(w.root, 'leads', 'evrloot.json'), 'utf8')).sid === 'lead0009');
  await orch.ready();
  w.stop('evr00001', join(w.root, 'idea-74'), 'Done for the lead.');
  await inboxHas(w.root, /Done for the lead\./)();
  assert.equal(orch.lines.some(l => /Done for the lead/.test(l)), false, 'the lead is up, so its line went to the inbox');
  await kill(orch.p);
});

test('lead start never types the re-arm prompt over a draft or into a blocked lead, like steer', () => {
  const w = orchDir();
  const live = (status: string) => [{ name: 'lead-evrloot', pane_id: 'w7:p2', workspace_id: 'w7', agent_status: status, agent_session: { value: 'lead0001' } }];
  const typing = herdrStub({ agents: live('idle'), screen: 'some output\n❯ half a sentence\n────' });
  const r = orchCmd(w.root, typing.env, 'lead', 'start', 'evrloot');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /re-arm prompt not sent: that pane has an unsent draft \("half a sentence"\)/);
  assert.equal(typing.calls().some(c => c.startsWith('agent prompt')), false);
  const blocked = herdrStub({ agents: live('blocked') });
  assert.match(orchCmd(w.root, blocked.env, 'lead', 'start', 'evrloot').stderr, /re-arm prompt not sent: session is blocked on a dialog/);
  assert.equal(blocked.calls().some(c => c.startsWith('agent prompt')), false);
});

test('lead and decision commands refuse bad input before touching herdr', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-lead-cmd-'));
  mkdirSync(join(root, 'decisions'));
  writeFileSync(join(root, 'decisions', 'D-07.md'), '# D-07: old\n');
  const orch = (...a: string[]) => orchCmd(root, herdrStub().env, ...a);
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
