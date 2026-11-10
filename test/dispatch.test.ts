import { test } from 'node:test';
import assert from 'node:assert/strict';
import { herdrCaps, promptOutcome, readyStep, submitStep,isGarbledPrompt, prTitle, promptVerdict, pickWinner, resolveProject, score, canDispatch, canSteer, parseDiskFloor, renderConsumers, scratchDir, workerComposeProjects, inputDraft, cleanupBlocker, isTrustDialog, trustKeys, parseCap, parseProjects, workerBrief, workerPrompt, potetoLine, parseAutonomy, type Worker } from '../src/dispatch.ts';

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

test('compose projects of a worker match by name only, never by config files', () => {
  const wk = { name: 'pulse-social', repo: 'tiki-pulse', worktree: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social' };
  const ps = [
    { Name: 'orch-pulse-social', ConfigFiles: '/elsewhere/docker-compose.yml' },
    { Name: 'pulsesocialwk', ConfigFiles: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social/docker-compose.dev.yml' },
    { Name: 'tiki-pulse-pulse-social' },
    { Name: 'orch-pulse-social2', ConfigFiles: '/h/.herdr/worktrees/tiki-pulse/orch-pulse-social2/docker-compose.yml' },
    { Name: 'tiki-pulse', ConfigFiles: '/h/code/tiki-pulse/docker-compose.yml' },
  ];
  assert.deepEqual(workerComposeProjects(wk, ps), ['orch-pulse-social', 'tiki-pulse-pulse-social']);
  const b1 = { name: 'b1', repo: 'evrloot-next', worktree: '/h/.herdr/worktrees/evrloot-next/orch-b1' };
  assert.deepEqual(workerComposeProjects(b1, [{ Name: 'evr-b1', ConfigFiles: '/h/.herdr/worktrees/evrloot-next/orch-b1/packages/db/compose.yaml' }]), [], 'a kept stack started from the worktree survives');
});

test('steering skips focused and blocked panes', () => {
  assert.equal(canSteer({ agent_status: 'idle', focused: true, pane_id: 'p' }), null, 'focused but empty input: send');
  assert.match(canSteer({ agent_status: 'idle', focused: true, pane_id: 'p' }, 'half a sentence')!, /typing/);
  assert.match(canSteer({ agent_status: 'idle', pane_id: 'p' }, 'left behind')!, /unsent draft/);
  assert.match(canSteer({ agent_status: 'blocked', pane_id: 'p' })!, /decision/);
  assert.match(canSteer({ agent_status: 'blocked', pane_id: 'p' }, '1. Coffee')!, /decision/, 'a question dialog is no draft');
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
  assert.match(b, /^Review: don't run a code review yourself .*orch reviews your work after the gates/m);
  assert.match(b, /^Editing files: use the Edit and Write tools, never shell heredocs/m);
  assert.match(b, /removed when you are done, with their volumes \(`docker run --rm`, or `docker rm -f -v <name>`/);
  assert.ok(!workerBrief('x', parseProjects(md)[1], { name: 'pr7', branch: 'orch/pr7' }, false).includes('Other workers:'), 'no merge line for PR or stacked workers');
  assert.match(b, /^Other workers: before the final test run, merge origin\/<default> into your branch \(`git fetch origin` then `git merge --autostash --no-edit origin\/<default>`; your changes stay uncommitted; never rebase\) and rerun the tests\. .*mention any such overlap in your report\.$/m);
  assert.match(b, /^Disk: this Mac is often short on space; check df before writing more than 500 MB and keep installs and copies minimal\.$/m);
  assert.equal(workerPrompt('/x/briefs/flag.md'), 'Read /x/briefs/flag.md and follow it.');
  assert.equal(potetoLine({ kind: 'claude' }, '/p/SKILL.md'), 'First read /p/SKILL.md in full and work by it (poteto-mode).\n\n');
  assert.equal(potetoLine({ kind: 'codex' }, '/p/SKILL.md'), '');
  assert.equal(potetoLine({ kind: 'claude' }, false), '');
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
    ev('idea-bridge', 'Idea', '2026-10-06T08:00Z', { msg: 'IDEA I-1 new ann: more loot' }),
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

test('a prompt pasted before the input took over is spotted on screen', () => {
  assert.ok(isGarbledPrompt('  ^U[?2026;2$y^[[?62;22c\n^[[200~/pstack:poteto-mode You are worker idea-3^[[201~'));
  assert.ok(!isGarbledPrompt('⏺ Reading the brief\n❯ '));
});

test('overlap pairs workers that change the same files, later worker named first', async () => {
  const { overlaps, overlapLine } = await import('../src/dispatch.ts');
  const os = overlaps('orch', [
    { name: 'b', started: '2026-11-01 10:00', files: ['src/orch.ts', 'src/watch.ts', 'README.md'] },
    { name: 'a', started: '2026-11-01 09:00', files: ['src/orch.ts', 'src/dispatch.ts', 'README.md'] },
    { name: 'c', started: '2026-11-01 11:00', files: ['docs/x.md'] },
  ]);
  assert.deepEqual(os, [{ repo: 'orch', earlier: 'a', later: 'b', files: ['README.md', 'src/orch.ts'] }]);
  assert.equal(overlapLine(os[0]), 'OVERLAP orch: b (later) and a both change 2 files: README.md, src/orch.ts');
  assert.deepEqual(overlaps('orch', [{ name: 'a', started: '1', files: ['x'] }, { name: 'b', started: '2', files: ['y'] }]), []);
  const many = overlaps('r', [{ name: 'a', started: '1', files: 'abcdefghij'.split('') }, { name: 'b', started: '2', files: 'abcdefghij'.split('') }]);
  assert.equal(overlapLine(many[0]), 'OVERLAP r: b (later) and a both change 10 files: a, b, c, d, e, f, g, h and 2 more');
});

test('watcher reports a pair once, again only when files join, and forgets pairs that stop overlapping', async () => {
  const { newOverlaps } = await import('../src/dispatch.ts');
  const o = (files: string[]) => ({ repo: 'orch', earlier: 'a', later: 'b', files });
  const first = newOverlaps([o(['x'])], {});
  assert.deepEqual(first.lines, ['OVERLAP orch: b (later) and a both change 1 file: x']);
  assert.deepEqual(newOverlaps([o(['x'])], first.seen).lines, []);
  const grown = newOverlaps([o(['x', 'y'])], first.seen);
  assert.deepEqual(grown.lines, ['OVERLAP orch: b (later) and a both change 2 files: x, y']);
  assert.deepEqual(newOverlaps([o(['x'])], grown.seen).lines, [], 'a file leaving is not news');
  const gone = newOverlaps([], grown.seen);
  assert.deepEqual(gone.seen, {});
  assert.equal(newOverlaps([o(['x'])], gone.seen).lines.length, 1, 'a pair that comes back is reported again');
  const other = { 'tariffs a b': ['y'] };
  assert.deepEqual(newOverlaps([], { ...grown.seen, ...other }, r => r === 'orch').seen, other, 'a repo not scanned keeps its pairs');
  assert.deepEqual(newOverlaps([], { ...grown.seen, ...other }).seen, {}, 'scanning all repos forgets what is gone');
});

test('overlap leaves out a Claude/Codex pair and a stack of parent, child and grandchild', async () => {
  const { overlaps } = await import('../src/dispatch.ts');
  const t = (name: string, started: string, extra: { pair?: string; parent?: string } = {}) => ({ name, started, files: ['x'], ...extra });
  assert.deepEqual(overlaps('r', [t('fix-cl', '1', { pair: 'fix' }), t('fix-cx', '1', { pair: 'fix' })]), []);
  assert.deepEqual(overlaps('r', [t('parent', '1'), t('child', '2', { parent: 'parent' }), t('grand', '3', { parent: 'child' }), t('other', '4')])
    .map(o => `${o.earlier}+${o.later}`), ['parent+other', 'child+other', 'grand+other']);
  assert.deepEqual(overlaps('r', [t('a', '1', { parent: 'b' }), t('b', '2', { parent: 'a' })]), [], 'a parent cycle ends');
});


test('a prompt counts as landed only after 6 s busy with an empty box and no raw paste codes', () => {
  const busy = { status: 'working', screen: '⏺ Reading the brief\n❯ ', draft: '' };
  const idle = { status: 'idle', screen: '❯ ', draft: '' };
  const raw = { status: 'working', screen: '❯ Read brief.md\n^[[200~Read brief.md^[[201~', draft: 'Read brief.md' };
  assert.equal(promptVerdict([busy]), 'pending');
  assert.equal(promptVerdict([busy, busy]), 'pending', 'herdr says working early; wait for late raw codes');
  assert.equal(promptVerdict([busy, busy, busy]), 'landed');
  assert.equal(promptVerdict([busy, busy, raw]), 'garbled', 'codes that show up late still fail it (idea-28, 2026-11-03)');
  assert.equal(promptVerdict([busy, busy, { ...busy, draft: 'Read brief.md' }]), 'pending', 'text still in the box has not been sent');
  assert.equal(promptVerdict([idle, idle, idle]), 'pending');
  assert.equal(promptVerdict(Array(10).fill(idle)), 'idle');
  assert.equal(promptVerdict([idle, { ...busy, status: 'done' }, busy]), 'landed');
  assert.equal(promptVerdict([busy, busy, { ...busy, draft: null }]), 'landed', 'no input box drawn while it works');
});

test('only a herdr server from 0.9.4 on is trusted to keep pane input clean', () => {
  assert.deepEqual(herdrCaps('0.9.3'), { cleanInput: false });
  assert.deepEqual(herdrCaps('0.9.4'), { cleanInput: true });
  assert.deepEqual(herdrCaps('0.9.5'), { cleanInput: true });
  assert.deepEqual(herdrCaps('0.10.0'), { cleanInput: true });
  assert.deepEqual(herdrCaps('1.0.0-beta.1'), { cleanInput: true });
  assert.deepEqual(herdrCaps('0.8.12'), { cleanInput: false });
  assert.deepEqual(herdrCaps(undefined), { cleanInput: false }, 'an unreadable version keeps the screen checks');
  assert.deepEqual(herdrCaps('garbage'), { cleanInput: false });
});

test('agent prompt --wait: settled or still working landed, stalled gets one more Enter, anything else failed', () => {
  assert.deepEqual(promptOutcome({ result: { agent: { agent_status: 'done' } } }), { landed: 'done' });
  assert.deepEqual(promptOutcome({ result: { agent: { agent_status: 'blocked' } } }), { landed: 'blocked' });
  assert.deepEqual(promptOutcome({ error: { code: 'timeout', message: 'timed out waiting for agent status' } }), { landed: 'working' });
  assert.deepEqual(promptOutcome({ error: { code: 'agent_prompt_stalled', message: 'x' } }), { stalled: true });
  assert.deepEqual(promptOutcome({ error: { code: 'agent_blocked', message: 'agent hprobe is blocked and requires interactive input' } }),
    { failed: 'agent_blocked agent hprobe is blocked and requires interactive input' });
  assert.deepEqual(promptOutcome({ error: { code: 'agent_not_found' } }), { failed: 'agent_not_found' });
});

// Drives a step machine with scripted answers, collecting the actions it asks for.
function drive<S, A>(step: (s: S, a: any) => [S, A], start: S, answers: unknown[]): A[] {
  const actions: A[] = [];
  let s = start;
  for (const a of answers) { const [n, act] = step(s, a); s = n; actions.push(act); }
  return actions;
}
const reply = (agent_status: string, state_change_seq = 1) => ({ result: { agent: { agent_status, state_change_seq } } });

test('submitStep: a landed prompt is checked for raw paste codes once', () => {
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [reply('done', 8), '⏺ PONG\n❯ ']),
    [{ read: true }, { landed: 'done' }]);
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [{ error: { code: 'timeout' } }, '^[[200~Read brief.md^[[201~']),
    [{ read: true }, { failed: 'it arrived garbled (raw paste codes on screen)' }]);
  assert.deepEqual(submitStep({ at: 'prompt' }, { error: { code: 'agent_blocked', message: 'agent x is blocked' } })[1],
    { failed: 'agent_blocked agent x is blocked' });
});

test('submitStep: a stalled prompt gets one Enter; a new done counts, the old one does not', () => {
  const stalled = { error: { code: 'agent_prompt_stalled' } };
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [stalled, reply('done', 9), '❯ ']),
    [{ enter: ['working', 'blocked', 'done'] }, { read: true }, { landed: 'done' }], 'a quick turn finished before herdr looked');
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [stalled, reply('done', 7), reply('working', 10), '⏺ x']),
    [{ enter: ['working', 'blocked', 'done'] }, { wait: ['working', 'blocked'] }, { read: true }, { landed: 'working' }]);
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [stalled, reply('done', 7), { error: { code: 'timeout' } }]),
    [{ enter: ['working', 'blocked', 'done'] }, { wait: ['working', 'blocked'] }, { failed: 'the agent never picked it up (no activity after the prompt and one more Enter)' }]);
  assert.deepEqual(drive((s, a) => submitStep(s, a, 7), { at: 'prompt' } as const, [stalled, { error: { code: 'timeout' } }])[1],
    { failed: 'the agent never picked it up (no activity after the prompt and one more Enter)' });
});

test('readyStep: idle or done, then two equal screens; blocked only once the wait runs out', () => {
  const ok = reply('idle');
  assert.deepEqual(drive(readyStep, { at: 'wait' } as const, [ok, 'booting', 'box', 'box']),
    [{ read: true }, { read: true }, { read: true }, { ready: ok }]);
  assert.deepEqual(drive(readyStep, { at: 'wait' } as const, [ok, '', '']).at(-1), { read: true }, 'an empty read is no screen');
  assert.deepEqual(drive(readyStep, { at: 'wait' } as const, [ok, 'a', 'b', 'c', 'd', 'e', 'f']).at(-1), { ready: ok }, 'six reads at most');
  assert.deepEqual(drive(readyStep, { at: 'wait' } as const, [{ error: { code: 'timeout' } }, reply('blocked')]),
    [{ get: true }, { error: { code: 'agent_blocked', message: 'blocked after trust' } }]);
  assert.deepEqual(drive(readyStep, { at: 'wait' } as const, [{ error: { code: 'timeout' } }, reply('working')])[1],
    { error: { code: 'timeout', message: 'not ready after 30 s' } });
  assert.deepEqual(readyStep({ at: 'wait' }, { error: { code: 'agent_not_found', message: 'gone' } })[1], { error: { code: 'agent_not_found', message: 'gone' } });
});

test('prTitle takes the plan line of a later round, strips bold and cuts at the sentence', () => {
  const round = 'Idea I-7 was built and shipped before; this is round 2. Its dossier is below.\n\n**Old plan**\n\n## Round 2: the plan to build\n\n**Prices on hover, in the old game\'s look**\n\nWhat changes';
  assert.equal(prTitle(round), "Prices on hover, in the old game's look");
  assert.equal(prTitle('**Walk through expeditions with the arrow keys**\n\nWhat changes'), 'Walk through expeditions with the arrow keys');
  assert.equal(prTitle('Performance fix: a lighter Missions window. 6. **A lighter Missions window.** Find'), 'Performance fix: a lighter Missions window');
  const long = prTitle('word '.repeat(30));
  assert.ok(long.length <= 70 && !long.endsWith(' '));
});
