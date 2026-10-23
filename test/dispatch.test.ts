import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickWinner, resolveProject, score, canDispatch, canSteer, parseDiskFloor, renderConsumers, scratchDir, workerComposeProjects, inputDraft, cleanupBlocker, isTrustDialog, trustKeys, parseCap, parseProjects, workerBrief, workerPrompt, parseAutonomy, type Worker } from '../src/dispatch.ts';

const md = `# projects

| Repo | Path | Gates | Codex | Notes |
|---|---|---|---|---|
| orch | \`~/orch\` | \`npm test\` | yes | this repo |
| tariffs | /home/me/code/tariffs | \`npm run lint\`, \`npm test\` | no | |
`;

test('registry rows parse with gates from code spans and ~ expanded', () => {
  const [orch, tariffs] = parseProjects(md);
  assert.equal(orch.repo, 'orch');
  assert.equal(orch.path, `${process.env.HOME}/orch`);
  assert.deepEqual(tariffs.gates, ['npm run lint', 'npm test']);
  assert.equal(orch.notes, 'this repo');
  assert.equal(parseProjects('# projects\n\n| Repo | Path | Gates | Notes |\n|---|---|---|---|\n').length, 0);
});

test('cap comes from policies, defaults to 4', () => {
  assert.equal(parseCap('Concurrency cap: 2 workers'), 2);
  assert.equal(parseCap('nothing here'), 4);
});

const w = (name: string, status: Worker['status'] = 'running'): Worker =>
  ({ name, repo: 'orch', task: '', branch: '', worktree: '', workspace: '', pane: '', sid: '', started: '', status });

test('dispatch refuses bad names, taken names and a full cap', () => {
  assert.match(canDispatch([], 4, 'Bad Name', [])!, /name must match/);
  assert.match(canDispatch([], 4, 'fix', [{ name: 'fix', agent_status: 'idle', pane_id: 'w1:p1' }])!, /already named/);
  assert.match(canDispatch([w('a'), w('b')], 2, 'c', [])!, /cap reached \(2\/2\)/);
  assert.equal(canDispatch([w('a'), w('b', 'closed')], 2, 'c', []), null);
});

test('dispatch refuses below the disk floor, which local.md can set', () => {
  assert.equal(parseDiskFloor('Disk floor: 35 GB'), 35);
  assert.equal(parseDiskFloor('Concurrency cap: 2 workers'), 20);
  assert.equal(canDispatch([], 4, 'c', [], { freeGb: 12, floorGb: 20 }), 'disk floor: 12 GB free on the data volume, floor is 20 GB (Disk floor in local.md)');
  assert.equal(canDispatch([], 4, 'c', [], { freeGb: 20, floorGb: 20 }), null);
  assert.match(canDispatch([], 4, 'Bad', [], { freeGb: 1, floorGb: 20 })!, /name must match/, 'a bad name is reported first');
});

test('top consumers are listed biggest first in GB', () => {
  assert.equal(renderConsumers([{ path: '/a', kb: 1048576 }, { path: '/b', kb: 5 * 1048576 }, { path: '/c', kb: 524288 }], 2),
    '   5.0 GB  /b\n   1.0 GB  /a');
});

test('a worker scratch dir is its worktree path with dashes', () => {
  assert.equal(scratchDir('/private/tmp/claude-501', '/Users/lucas/.herdr/worktrees/orch/orch-disk'),
    '/private/tmp/claude-501/-Users-lucas--herdr-worktrees-orch-orch-disk');
});

test('compose projects of a worker match by name or by config files in its worktree', () => {
  const wk = { name: 'pulse-social', repo: 'tiki-pulse', worktree: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social' };
  const ps = [
    { Name: 'orch-pulse-social', ConfigFiles: '/elsewhere/docker-compose.yml' },
    { Name: 'pulsesocialwk', ConfigFiles: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social/docker-compose.dev.yml' },
    { Name: 'tiki-pulse-pulse-social' },
    { Name: 'orch-pulse-social2', ConfigFiles: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social2/docker-compose.yml' },
    { Name: 'tiki-pulse', ConfigFiles: '/h/code/tiki-pulse/docker-compose.yml' },
  ];
  assert.deepEqual(workerComposeProjects(wk, ps), ['orch-pulse-social', 'pulsesocialwk', 'tiki-pulse-pulse-social']);
});

test('steering skips focused and blocked panes', () => {
  assert.equal(canSteer({ agent_status: 'idle', focused: true, pane_id: 'p' }), null, 'focused but empty input: send');
  assert.match(canSteer({ agent_status: 'idle', focused: true, pane_id: 'p' }, 'half a sentence')!, /typing/);
  assert.match(canSteer({ agent_status: 'idle', pane_id: 'p' }, 'left behind')!, /unsent draft/);
  assert.match(canSteer({ agent_status: 'blocked', pane_id: 'p' })!, /decision/);
  assert.match(canSteer(undefined)!, /no live agent/);
  assert.equal(canSteer({ agent_status: 'done', pane_id: 'p' }), null);
});

test('cleanup is blocked by dirty or unpushed work', () => {
  assert.match(cleanupBlocker(' M src/a.ts\n', '')!, /uncommitted/);
  assert.match(cleanupBlocker('', 'abc123 wip\n')!, /no other branch or remote/);
  assert.equal(cleanupBlocker('', ''), null);
});

test('trust dialog is recognised', () => {
  assert.ok(isTrustDialog('Quick safety check: Is this a project you created or one you trust?'));
  assert.ok(!isTrustDialog('❯ '));
  assert.deepEqual(trustKeys('Is this a project you created or one you trust?'), ['down', 'enter']);
  assert.deepEqual(trustKeys('Trust this folder? Codex can read...\n› 1. Trust and continue'), ['enter']);
});

test('worker brief carries task, gates and the commit rule; the prompt is one line that starts poteto-mode', () => {
  const b = workerBrief('add a flag\nwith detail', parseProjects(md)[1], { name: 'flag', branch: 'orch/flag' });
  assert.match(b, /## Task\n\nadd a flag\nwith detail/);
  assert.match(b, /`npm run lint`, `npm test`/);
  assert.match(b, /leave your changes uncommitted; orch runs the gates and commits/);
  assert.match(b, /in-scope implementation and investigation calls yourself/);
  assert.match(b, /bound to 127\.0\.0\.1/);
  assert.match(b, /^Disk: this Mac is often short on space; check df before writing more than 500 MB and keep installs and copies minimal\.$/m);
  const p = workerPrompt({ name: 'flag', kind: 'claude' }, '/x/briefs/flag.md');
  assert.equal(p, '/pstack:poteto-mode You are worker flag, dispatched by orch. Read your brief at /x/briefs/flag.md and follow it.');
  assert.ok(!p.includes('\n'));
  assert.ok(workerPrompt({ name: 'x', kind: 'codex' }, '/b').startsWith('You are worker x'));
  assert.ok(workerPrompt({ name: 'x', kind: 'claude' }, '/b', false).startsWith('You are worker x'), 'no pstack, no poteto-mode');
});

test('restore list keeps recent sessions that died without SessionEnd', async () => {
  const { restoreList, resumeCommand } = await import('../src/dispatch.ts');
  const ev = (sid: string, event: string, ts: string, extra = {}) => ({ sid, event, ts, cwd: '/r', prompt: '', msg: '', ...extra });
  const feed = [
    ev('a', 'UserPromptSubmit', '2026-10-06T08:00Z', { prompt: 'fix the parser' }), ev('a', 'Stop', '2026-10-06T08:05Z'),
    ev('b', 'SessionStart', '2026-10-06T08:00Z'), ev('b', 'SessionEnd', '2026-10-06T09:00Z'),
    ev('c', 'Stop', '2026-10-06T08:00Z', { agent: 'codex' }),
    ev('d', 'Stop', '2026-10-06T08:00Z'),
    ev('e', 'Stop', '2026-10-01T08:00Z'),
  ];
  const lost = restoreList(feed, new Set(['d']), '2026-10-04T00:00Z');
  assert.deepEqual(lost.map(l => l.sid), ['a', 'c']);
  assert.equal(lost[0].asked, 'fix the parser');
  assert.equal(resumeCommand(lost[1]), 'codex resume c');
  assert.equal(resumeCommand(lost[0]), 'claude --resume a');
});

test('any git repo resolves: registry name, path, or folder under ~/code', () => {
  const reg = parseProjects(md);
  const tops: Record<string, string> = { [`${process.env.HOME}/code/web`]: `${process.env.HOME}/code/web`, '/tmp/x/sub': '/tmp/x' };
  const top = (p: string) => tops[p] ?? null;
  assert.equal(resolveProject('orch', reg, top)!.gates[0], 'npm test');
  assert.deepEqual(resolveProject('web', reg, top), { repo: 'web', path: `${process.env.HOME}/code/web`, gates: [], notes: '' });
  assert.equal(resolveProject('/tmp/x/sub', reg, top)!.repo, 'x');
  assert.equal(resolveProject('nope', reg, top), null);
});

const F = (severity: 'blocking' | 'medium' | 'minor') => ({ file: 'a', line: 1, severity, title: 't', why: '' });
const cand = (name: string, gatesPassed: boolean, diffLines: number, review: any) => ({ name, kind: 'claude' as const, gatesPassed, diffLines, review });
const empty = { both: [], claudeOnly: [], codexOnly: [] };

test('winner: gates first, then review score, then smaller diff', () => {
  assert.equal(pickWinner([cand('a', false, 5, empty), cand('b', false, 5, empty)]).winner, null);
  assert.equal(pickWinner([cand('a', false, 5, empty), cand('b', true, 50, { ...empty, claudeOnly: [F('blocking')] })]).winner!.name, 'b');
  const agreedMedium = { ...empty, both: [{ claude: F('medium'), codex: F('blocking') }] };
  assert.equal(score(agreedMedium), 10);
  assert.equal(score({ ...empty, codexOnly: [F('medium'), F('minor')] }), 1);
  assert.equal(pickWinner([cand('a', true, 5, agreedMedium), cand('b', true, 90, { ...empty, codexOnly: [F('medium')] })]).winner!.name, 'b');
  const tie = pickWinner([cand('a', true, 90, empty), cand('b', true, 20, empty)]);
  assert.equal(tie.winner!.name, 'b');
  assert.match(tie.reason, /smaller diff/);
});

test('autonomy is off by default and local.md wins over policies.md', () => {
  const policies = '## Autonomy\n\n- push: off\n- comment: off\n- approve: off\n- merge: off\n\n## Learning\n\n- project: on\n';
  assert.deepEqual([...parseAutonomy('', policies)], []);
  const local = '# local\n\n## Autonomy\n\n- push: on\n- merge: on\n';
  assert.deepEqual([...parseAutonomy(local, policies)].sort(), ['merge', 'push']);
  assert.deepEqual([...parseAutonomy('- push: on', policies)], [], 'outside the Autonomy section it does nothing');
});

// Captured from real panes with `herdr agent read --source visible --ansi`.
test('inputDraft ignores dim suggestions and grey prompt, keeps typed text', () => {
  const E = '\x1b';
  assert.equal(inputDraft(`header\n\u276f ${E}[0m${E}[2mTry "write a test for <filepath>"${E}[0m\r\n\u2500\u2500\u2500\nfooter`), '');
  assert.equal(inputDraft(`${E}[0m${E}[38;2;153;153;153m\u276f ${E}[0m\r`), '');
  assert.equal(inputDraft(`\u276f hello typed draft\r`), 'hello typed draft');
  assert.equal(inputDraft(`\u276f fix it${E}[2m suggestion tail${E}[0m`), 'fix it');
  assert.equal(inputDraft(`\u203a codex draft`), 'codex draft');
  assert.equal(inputDraft('no prompt here'), null);
});

test('inputDraft keeps truecolor typed text, reads multi-line drafts, ignores menus above', () => {
  const E = '\x1b';
  assert.equal(inputDraft(`\u276f ${E}[38;2;220;120;80mcoloured words${E}[0m`), 'coloured words');
  assert.equal(inputDraft(`\u276f first line\nsecond line\n\u2500\u2500\u2500\nstatus bar`), 'first line second line');
  assert.equal(inputDraft(`\u276f 1. Option one\n  2. Option two\n\u2500\u2500\n\u276f ${E}[2mTry something${E}[0m\n\u2500\u2500`), '');
  assert.equal(inputDraft(`\u276f ${E}[38;5;245mgrey 256${E}[0m`), '');
  assert.equal(inputDraft(`\u276f ${E}[38;2;120;120;120mreal grey text${E}[0m`), 'real grey text');
});
