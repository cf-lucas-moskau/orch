import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueue, checkAnswer, mediaPaths, reviewFor, urls, validAnswer, type Item, type Ledger } from '../src/queue.ts';
import type { Worker } from '../src/dispatch.ts';
import type { Idea } from '../src/ideas.ts';

const decision = (id: string, status: string, opened: string, extra = '') => ({ id, md: `# ${id}: Push the fix?

- Session: fixer (w1, w1:p1)
- Opened: ${opened}
- Status: ${status}
- Stakes: pushes to main
- Gates: npm test passed

## Facts
- The fix is in /tmp/q/shot.png and clips/run.mp4.${extra}

## Options
1. Push now
2. Wait

## Recommendation
1, the tests pass.

## Outcome
` });

const worker = (name: string, sid: string, extra: Partial<Worker> = {}): Worker =>
  ({ name, sid, repo: 'game', task: `task of ${name}`, branch: `orch/${name}`, worktree: `/w/${name}`, pane: 'w9:p1', status: 'running', ...extra } as Worker);

const idea = (id: string, extra: Partial<Idea>): Idea =>
  ({ id, thread: 't', message: 'm', author: { id: '1', name: 'kingluuu' }, text: `${id} text\nmore`, state: 'talk', created: '', updated: '2026-11-09T10:00:00Z', ...extra } as Idea);

const ledger = (p: Partial<Ledger>): Ledger =>
  ({ root: '/orch', decisions: [], workers: [], feed: [], ideas: [], ideaFiles: {}, log: '', prStates: {}, ...p });

const ev = (sid: string, ts: string, event: string, msg: string, extra: object = {}) => ({ ts, sid, event, cwd: '', prompt: '', msg, ...extra });
const noRev = ({ rev, ...rest }: Item) => rest;

test('open decisions only, with the deck answers, recommendation, links and media', () => {
  const q = buildQueue(ledger({ decisions: [decision('D-2', 'accepted', '2026-11-08 09:00'), decision('D-3', 'open', '2026-11-09 09:00', ' See https://github.com/o/game/pull/7.')] }));
  assert.equal(q.length, 1);
  assert.match(q[0].rev, /^[0-9a-f]{16}$/);
  assert.deepEqual(noRev(q[0]), {
    key: 'D-3', kind: 'decision', title: 'D-3: Push the fix?', who: 'fixer (w1, w1:p1)', since: '2026-11-09 09:00',
    recommendation: '1, the tests pass.',
    detail: 'Stakes: pushes to main\n\nGates: npm test passed\n\nFacts\n- The fix is in /tmp/q/shot.png and clips/run.mp4. See https://github.com/o/game/pull/7.\n\nOptions\n1. Push now\n2. Wait',
    links: [{ label: 'game #7', url: 'https://github.com/o/game/pull/7' }],
    media: ['/tmp/q/shot.png', '/orch/clips/run.mp4'], docs: ['/orch/decisions/D-3.md'],
    answers: { accept: 'D-3: yes, go with your recommendation.', reject: 'D-3: no, ', edit: 'D-3: ' },
  });
});

test('a worker question or permission prompt is queued, keyed by its occurrence, until someone answers it', () => {
  const workers = [worker('asker', 's1'), worker('blocked', 's2'), worker('answered', 's3'), worker('closed', 's4', { status: 'closed' })];
  const feed = [
    ev('s1', '2026-11-09T10:00:00Z', 'Stop', 'Tests pass. Should I add the e2e test too?'),
    ev('s2', '2026-11-09T09:00:00Z', 'Notification', 'Claude needs your permission to use Bash'),
    ev('s3', '2026-11-09T09:00:00Z', 'Stop', 'Should I push?'),
    ev('s3', '2026-11-09T09:01:00Z', 'UserPromptSubmit', ''),
    ev('s4', '2026-11-09T09:00:00Z', 'Stop', 'Should I push?'),
  ];
  const q = buildQueue(ledger({ workers, feed }));
  assert.deepEqual(q.map(i => [i.key, i.kind, i.title]), [
    ['worker:blocked@2026-11-09T09:00:00Z', 'blocked', 'blocked is blocked: Claude needs your permission to use Bash'],
    ['worker:asker@2026-11-09T10:00:00Z', 'question', 'asker asks'],
  ]);
  assert.deepEqual(q[1].answers, { accept: 'Steer asker: yes, go with your recommendation.', reject: 'Steer asker: no, ', edit: 'Steer asker: ' });
  assert.equal(q[1].detail, 'Tests pass. Should I add the e2e test too?');
});

test('a Codex worker has no session id; its events are found by its worktree', () => {
  const q = buildQueue(ledger({
    workers: [worker('cx', '', { worktree: '/w/cx', kind: 'codex' })],
    feed: [ev('codex-sid', '2026-11-09T10:00:00Z', 'Stop', 'Want me to push?', { cwd: '/w/cx', agent: 'codex' }),
      ev('other', '2026-11-09T11:00:00Z', 'Stop', 'Should I merge?', { cwd: '/w/elsewhere', agent: 'codex' })],
  }));
  assert.deepEqual(q.map(i => [i.key, i.detail]), [['worker:cx@2026-11-09T10:00:00Z', 'Want me to push?']]);
});

test('idea asks are open questions keyed by when they were asked; deploys are ideas being put live', () => {
  const q = buildQueue(ledger({
    ideas: [
      idea('I-1', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Which room?', recommend: 'the north one', wait: true }], title: { title: 'Crafting room' } }),
      idea('I-2', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Old?', answered: '2026-11-09T08:01:00Z' }] }),
      idea('I-3', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Gone?' }], state: 'closed' }),
      idea('I-4', { state: 'building', stage: 'deploying', worker: 'idea-4', round: 2 }),
      idea('I-5', { state: 'building', stage: 'checking' }),
    ],
    ideaFiles: { 'I-1': ['/orch/ideas/inbox/I-1/a.png', '/orch/ideas/progress/I-1/b.mp4'] },
  }));
  assert.deepEqual(q.map(i => [i.key, i.title, i.who, i.recommendation]), [
    ['idea:I-1@2026-11-09T08:00:00Z', 'I-1 · Crafting room', 'asks kingluuu, no timeout', 'the north one'],
    ['deploy:I-4@2', 'Deploy I-4 · I-4 text', 'idea-4', ''],
  ]);
  assert.deepEqual(q[0].media, ['/orch/ideas/inbox/I-1/a.png', '/orch/ideas/progress/I-1/b.mp4']);
  assert.deepEqual(q[0].answers, { accept: 'I-1: answer the open question with your recommendation.', reject: 'I-1: not your recommendation, ', edit: 'I-1: ' });
  assert.equal(q[1].answers.accept, 'Deploy I-4 now.');
});

test('a PR is queued for merge until a merge line or GitHub says it is done, with its review from the log', () => {
  const log = [
    '- 2026-11-08 08:00 review game orch/a: 1 agreed, 0 Claude only, 0 Codex only -> reviews/2026-11-08-game-orcha.md',
    '- 2026-11-09 08:50 review game orch/a-apps-packages: 0 agreed, 1 Claude only, 0 Codex only -> reviews/2026-11-09-game-orcha-apps-packages.md',
    '- 2026-11-09 08:55 review game orch/a-2: 0 agreed, 0 Claude only, 0 Codex only -> reviews/2026-11-09-game-orcha-2.md',
    '- 2026-11-09 09:00 open-pr a (autonomous): https://github.com/o/game/pull/5',
    '- 2026-11-09 09:10 open-pr b (by Lucas): https://github.com/o/game/pull/6',
    '- 2026-11-09 09:20 open-pr c (autonomous): https://github.com/o/game/pull/8',
    '- 2026-11-09 09:30 merge game #6 (autonomous): squash-merged abcd1234',
    '- 2026-11-09 09:31 merge game #5 refused: checks pending',
  ].join('\n');
  const q = buildQueue(ledger({
    log, workers: [worker('a', 'sa'), worker('b', 'sb'), worker('c', 'sc'), worker('a-2', 'sa2')],
    prStates: { 'https://github.com/o/game/pull/8': 'MERGED' },
  }));
  assert.deepEqual(q.map(i => [i.key, i.title, i.docs, i.answers.accept]), [
    ['merge:game#5', 'Merge game #5 (a)', ['/orch/reviews/2026-11-09-game-orcha-apps-packages.md'], 'Merge https://github.com/o/game/pull/5 (a).'],
  ]);
});

test('a review belongs to the exact branch, never to a longer branch sharing its prefix', () => {
  const log = [
    '- 2026-11-07 13:36 review evr orch/idea-44: x -> reviews/2026-11-07-evr-orchidea-44.md',
    '- 2026-11-09 09:09 review evr orch/idea-44-2-apps-packages: x -> reviews/2026-11-09-evr-orchidea-44-2-apps-packages.md',
    '- 2026-11-09 09:10 review other orch/idea-44: x -> reviews/2026-11-09-other-orchidea-44.md',
  ].join('\n');
  const branches = ['orch/idea-44', 'orch/idea-44-2'];
  assert.equal(reviewFor(log, 'evr', 'orch/idea-44', branches), '2026-11-07-evr-orchidea-44.md');
  assert.equal(reviewFor(log, 'evr', 'orch/idea-44-2', branches), '2026-11-09-evr-orchidea-44-2-apps-packages.md');
  assert.equal(reviewFor(log, 'evr', 'orch/idea-4', branches), undefined);
});

test('ranked by kind, then oldest first', () => {
  const q = buildQueue(ledger({
    decisions: [decision('D-9', 'open', '2026-11-09 12:00'), decision('D-4', 'open', '2026-11-08 12:00')],
    ideas: [idea('I-1', { questions: [{ askedAt: '2026-11-01T08:00:00Z', text: 'q' }] })],
    workers: [worker('w', 's')],
    feed: [ev('s', '2026-11-07T10:00:00Z', 'Stop', 'Want me to push?')],
  }));
  assert.deepEqual(q.map(i => i.key), ['D-4', 'D-9', 'worker:w@2026-11-07T10:00:00Z', 'idea:I-1@2026-11-01T08:00:00Z']);
});

test('an answer must be the accept text or a finished reject or edit', () => {
  const [d] = buildQueue(ledger({ decisions: [decision('D-1', 'open', '')] }));
  assert.equal(validAnswer(d, 'D-1: yes, go with your recommendation.'), true);
  assert.equal(validAnswer(d, 'D-1: no, wait for the review'), true);
  assert.equal(validAnswer(d, 'D-1: '), false);
  assert.equal(validAnswer(d, 'D-2: yes, go with your recommendation.'), false);
  assert.equal(validAnswer(d, 'Steer x: rm -rf'), false);
});

test('a stale answer is refused: a newer prompt, a changed item, a reused idea, one already sent or sending', () => {
  const busy = { sending: new Set<string>(), sent: new Map<string, unknown>() };
  const workers = [worker('w', 's')];
  const first = buildQueue(ledger({ workers, feed: [ev('s', '2026-11-09T10:00:00Z', 'Notification', 'Claude needs your permission to use Bash')] }));
  const opened = first[0];
  // The first prompt was answered in the pane; a new one came up while the page still showed the old one.
  const later = buildQueue(ledger({ workers, feed: [
    ev('s', '2026-11-09T10:00:00Z', 'Notification', 'Claude needs your permission to use Bash'),
    ev('s', '2026-11-09T10:01:00Z', 'UserPromptSubmit', ''),
    ev('s', '2026-11-09T10:05:00Z', 'Notification', 'Claude needs your permission to use Bash'),
  ] }));
  const allow = 'w waits on a permission prompt: allow it.';
  assert.deepEqual(checkAnswer(later, { key: opened.key, rev: opened.rev, text: allow }, busy),
    { status: 409, error: 'worker:w@2026-11-09T10:00:00Z left the queue; nothing was sent' });
  assert.equal('item' in checkAnswer(later, { key: later[0].key, rev: later[0].rev, text: allow }, busy), true);

  const ask = (text: string, askedAt = '2026-11-09T08:00:00Z') => buildQueue(ledger({ ideas: [idea('I-1', { questions: [{ askedAt, text }] })] }));
  const [q1] = ask('North or south?');
  const accept = 'I-1: answer the open question with your recommendation.';
  assert.deepEqual(checkAnswer(ask('North or south?', '2026-11-09T09:00:00Z'), { key: q1.key, rev: q1.rev, text: accept }, busy),
    { status: 409, error: 'idea:I-1@2026-11-09T08:00:00Z left the queue; nothing was sent' }, 'a new question on the same idea');
  assert.deepEqual(checkAnswer(ask('East or west?'), { key: q1.key, rev: q1.rev, text: accept }, busy),
    { status: 409, error: 'idea:I-1@2026-11-09T08:00:00Z changed since you opened it; look again' });

  busy.sending.add(q1.key);
  assert.deepEqual(checkAnswer([q1], { key: q1.key, rev: q1.rev, text: accept }, busy), { status: 409, error: 'idea:I-1@2026-11-09T08:00:00Z is being answered right now' });
  busy.sending.clear(); busy.sent.set(q1.key, {});
  assert.deepEqual(checkAnswer([q1], { key: q1.key, rev: q1.rev, text: accept }, busy), { status: 409, error: 'idea:I-1@2026-11-09T08:00:00Z was already answered' });
});

test('media paths and links are found in prose', () => {
  assert.deepEqual(mediaPaths('see `/a/b c.png`, ~/shots/x.webp and reviews/clip.mp4. Also left/right and foo.png?', '/orch', '/Users/me'),
    ['/Users/me/shots/x.webp', '/orch/reviews/clip.mp4']);
  assert.deepEqual(urls('PR https://github.com/o/r/pull/3, then https://api.runforit.io.'),
    [{ label: 'r #3', url: 'https://github.com/o/r/pull/3' }, { label: 'api.runforit.io', url: 'https://api.runforit.io' }]);
});

const killPort = (port: number) => {
  const pid = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
  for (const p of pid.split('\n').filter(Boolean)) process.kill(Number(p));
};

test('the watcher starts the queue page when its port is down, and it outlives the watcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-queue-watch-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const home = join(dir, 'home');
  mkdirSync(join(home, 'Library', 'Logs'), { recursive: true });
  for (const d of ['feed', 'ideas']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'ideas', 'config.json'), '{"adapter":"mock"}');
  const pageUp = () => fetch(`http://127.0.0.1:${port}/api/queue`).then(r => r.ok, () => false);
  const w = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '../src/watch.ts')],
    { env: { ...process.env, ORCH_DIR: dir, ORCH_SID: 'test', ORCH_QUEUE_PORT: String(port), HOME: home } });
  try {
    const line = await new Promise<string>((done, fail) => {
      const t = setTimeout(() => fail(new Error('no QUEUE line in 15 s')), 15_000);
      let out = '';
      w.stdout.on('data', d => { out += d; const m = out.match(/^QUEUE .*$/m); if (m) { clearTimeout(t); done(m[0]); } });
    });
    assert.match(line, new RegExp(`^QUEUE started on http://127\\.0\\.0\\.1:${port} \\(it was down\\)(; tailnet login link \\(one use\\): http://\\S+:${port}/login\\?code=[0-9a-f]{32})?$`));
    w.kill();
    await new Promise(r => w.once('exit', r));
    assert.equal(await pageUp(), true, 'detached: stopping the watcher leaves the page running');
    assert.equal(statSync(join(dir, 'secrets', 'queue-token')).mode & 0o777, 0o600, 'the token is readable by the user only');
  } finally {
    w.kill();
    killPort(port);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A server on an orch folder of its own, with a fake herdr that records what orch would be sent.
async function page(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'orch-queue-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin); mkdirSync(join(dir, 'decisions'));
  writeFileSync(join(dir, 'decisions', 'D-7.md'), decision('D-7', 'open', '2026-11-09 09:00').md);
  writeFileSync(join(dir, 'decisions', 'D-8.md'), decision('D-8', 'open', '2026-11-09 10:00').md);
  writeFileSync(join(bin, 'herdr'), `#!/bin/bash
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"agent":"claude","terminal_title_stripped":"orch","cwd":"${dir}","pane_id":"w1:p1","agent_status":"idle","name":"orch"}]}}';;
  "agent read") printf '\\xe2\\x9d\\xaf \\n\\xe2\\x94\\x80\\xe2\\x94\\x80\\n';;
  "agent prompt") printf '%s\\n' "$3 $4" >> "${dir}/prompts.txt"; echo '{"result":{}}';;
  "agent get") echo '{"result":{"agent":{"agent_status":"working"}}}';;
esac
`);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\necho OPEN\n');
  writeFileSync(join(bin, 'tailscale'), '#!/bin/bash\nexit 1\n');
  for (const f of ['herdr', 'gh', 'tailscale']) chmodSync(join(bin, f), 0o755);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '../src/queue-run.ts')], {
    env: { ...process.env, ORCH_DIR: dir, ORCH_QUEUE_PORT: String(port), PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { srv.kill(); rmSync(dir, { recursive: true, force: true }); });
  let out = '';
  srv.stdout!.on('data', d => { out += d; });
  await new Promise<void>((res, rej) => { srv.stdout!.on('data', () => out.includes('queue on http://127.0.0.1') && res()); srv.on('exit', c => rej(new Error(`exit ${c}`))); });
  const base = `http://127.0.0.1:${port}`;
  const items = async (): Promise<Item[]> => (await (await fetch(`${base}/api/queue`)).json()).items;
  const post = (body: unknown, headers: Record<string, string> = { 'x-orch': 'queue' }, url = base) =>
    fetch(`${url}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const prompts = () => existsSync(join(dir, 'prompts.txt')) ? readFileSync(join(dir, 'prompts.txt'), 'utf8') : '';
  return { dir, port, base, items, post, prompts, out: () => out };
}

test('the page answers through orch steer into orch\'s pane, logged in log.md, once', async t => {
  const p = await page(t);
  const [d7] = await p.items();
  assert.deepEqual((await p.items()).map(i => i.key), ['D-7', 'D-8']);
  assert.match(await (await fetch(p.base)).text(), /<title>orch queue<\/title>/);
  assert.equal((await fetch(`${p.base}/doc?p=${encodeURIComponent(join(p.dir, 'decisions', 'D-7.md'))}`)).status, 200);
  assert.equal((await fetch(`${p.base}/doc?p=/etc/passwd`)).status, 404, 'only files the queue names');

  const yes = 'D-7: yes, go with your recommendation.';
  assert.equal((await p.post({ key: 'D-7', rev: d7.rev, text: yes }, {})).status, 403, 'no custom header, no answer');
  assert.equal((await p.post({ key: 'D-7', rev: d7.rev, text: yes }, { 'x-orch': 'queue', origin: 'https://evil.example' })).status, 403);
  assert.equal((await p.post({ key: 'D-7', rev: d7.rev, text: 'Steer x: something else' })).status, 400);
  assert.equal((await p.post({ key: 'D-7', rev: 'old', text: yes })).status, 409, 'a revision the page never saw');
  const rebound = await new Promise<number>(res => get({ host: '127.0.0.1', port: p.port, path: '/api/queue', headers: { host: `evil.example:${p.port}` } }, r => { r.resume(); res(r.statusCode!); }));
  assert.equal(rebound, 421, 'rebinding host refused');

  // Two devices answer at once: one goes through, the other is refused, and orch hears it once.
  const [a, b] = await Promise.all([
    p.post({ key: 'D-7', rev: d7.rev, text: 'D-7: no, wait for the review' }),
    new Promise(r => setTimeout(r, 300)).then(() => p.post({ key: 'D-7', rev: d7.rev, text: yes })),
  ]);
  assert.equal(a.status, 200, JSON.stringify(await a.clone().json()));
  assert.deepEqual([b.status, (await b.json()).error], [409, 'D-7 is being answered right now']);
  assert.equal(p.prompts(), 'w1:p1 D-7: no, wait for the review\n');
  assert.match(readFileSync(join(p.dir, 'log.md'), 'utf8'), /^- \S+ \S+ steer orch: D-7: no, wait for the review$/m);
  const after = await p.items() as (Item & { sent?: { text: string } })[];
  assert.equal(after[0].sent?.text, 'D-7: no, wait for the review', 'a second device sees it was answered');
  const again = await p.post({ key: 'D-7', rev: d7.rev, text: yes });
  assert.deepEqual([again.status, (await again.json()).error], [409, 'D-7 was already answered']);
  assert.equal(p.prompts(), 'w1:p1 D-7: no, wait for the review\n', 'nothing more reached orch');
});

test('an item that leaves or changes while its confirmation is open sends nothing', async t => {
  const p = await page(t);
  const [d7, d8] = await p.items();
  // The confirmation opened on D-7; orch closes it before the user presses send.
  writeFileSync(join(p.dir, 'decisions', 'D-7.md'), decision('D-7', 'accepted', '2026-11-09 09:00').md);
  const gone = await p.post({ key: 'D-7', rev: d7.rev, text: 'D-7: yes, go with your recommendation.' });
  assert.deepEqual([gone.status, (await gone.json()).error], [409, 'D-7 left the queue; nothing was sent']);
  // D-8's recommendation is rewritten while the user reads it.
  writeFileSync(join(p.dir, 'decisions', 'D-8.md'), decision('D-8', 'open', '2026-11-09 10:00').md.replace('1, the tests pass.', '2, wait for CI.'));
  const changed = await p.post({ key: 'D-8', rev: d8.rev, text: 'D-8: yes, go with your recommendation.' });
  assert.deepEqual([changed.status, (await changed.json()).error], [409, 'D-8 changed since you opened it; look again']);
  assert.equal(p.prompts(), '', 'orch was told nothing');
});

const tailnet = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))?.address;
test('tailnet requests need the token cookie, set once by a one-time login link', { skip: !tailnet && 'no tailnet address on this machine' }, async t => {
  const p = await page(t);
  const tail = `http://${tailnet}:${p.port}`;
  await new Promise(r => setTimeout(r, 300));
  const link = p.out().match(/^queue login link \(one use\): (\S+)$/m)?.[1];
  assert.match(link ?? '', new RegExp(`^${tail.replace(/\./g, '\\.')}/login\\?code=[0-9a-f]{32}$`));
  assert.equal((await fetch(`${tail}/api/queue`)).status, 401);
  assert.equal((await p.post({ key: 'D-7', rev: 'x', text: 'D-7: yes, go with your recommendation.' }, { 'x-orch': 'queue' }, tail)).status, 401);
  assert.equal((await fetch(`${tail}/api/queue`, { headers: { cookie: 'orch_queue=guess' } })).status, 401);

  const login = await fetch(link!, { redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal(cookie, `orch_queue=${readFileSync(join(p.dir, 'secrets', 'queue-token'), 'utf8').trim()}`);
  assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(link!, { redirect: 'manual' })).status, 403, 'the link works once');
  await new Promise(r => setTimeout(r, 200));
  assert.equal([...p.out().matchAll(/^queue login link/gm)].length, 2, 'a fresh link is printed for the next device');

  assert.equal((await fetch(`${tail}/api/queue`, { headers: { cookie } })).status, 200);
  const [d7] = await p.items();
  const r = await p.post({ key: 'D-7', rev: d7.rev, text: 'D-7: no, later' }, { 'x-orch': 'queue', cookie }, tail);
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(p.prompts(), 'w1:p1 D-7: no, later\n');
});
