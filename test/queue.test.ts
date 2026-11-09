import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQueue, mediaPaths, reviewFor, urls, validAnswer, type Ledger } from '../src/queue.ts';
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
  ({ root: '/orch', decisions: [], workers: [], feed: [], ideas: [], ideaFiles: {}, log: '', reviews: [], prStates: {}, ...p });

test('open decisions only, with the deck answers, recommendation, links and media', () => {
  const q = buildQueue(ledger({ decisions: [decision('D-2', 'accepted', '2026-11-08 09:00'), decision('D-3', 'open', '2026-11-09 09:00', ' See https://github.com/o/game/pull/7.')] }));
  assert.equal(q.length, 1);
  assert.deepEqual(q[0], {
    key: 'D-3', kind: 'decision', title: 'D-3: Push the fix?', who: 'fixer (w1, w1:p1)', since: '2026-11-09 09:00',
    recommendation: '1, the tests pass.',
    detail: 'Stakes: pushes to main\n\nGates: npm test passed\n\nFacts\n- The fix is in /tmp/q/shot.png and clips/run.mp4. See https://github.com/o/game/pull/7.\n\nOptions\n1. Push now\n2. Wait',
    links: [{ label: 'game #7', url: 'https://github.com/o/game/pull/7' }],
    media: ['/tmp/q/shot.png', '/orch/clips/run.mp4'], docs: ['/orch/decisions/D-3.md'],
    answers: { accept: 'D-3: yes, go with your recommendation.', reject: 'D-3: no, ', edit: 'D-3: ' },
  });
});

test('a worker question or permission prompt is queued until someone answers it', () => {
  const ev = (sid: string, ts: string, event: string, msg: string) => ({ ts, sid, event, cwd: '', prompt: '', msg });
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
    ['worker:blocked', 'blocked', 'blocked is blocked: Claude needs your permission to use Bash'],
    ['worker:asker', 'question', 'asker asks'],
  ]);
  assert.deepEqual(q[1].answers, { accept: 'Steer asker: yes, go with your recommendation.', reject: 'Steer asker: no, ', edit: 'Steer asker: ' });
  assert.equal(q[1].detail, 'Tests pass. Should I add the e2e test too?');
});

test('idea asks are open questions only; deploys are ideas being put live', () => {
  const q = buildQueue(ledger({
    ideas: [
      idea('I-1', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Which room?', recommend: 'the north one', wait: true }], title: { title: 'Crafting room' } }),
      idea('I-2', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Old?', answered: '2026-11-09T08:01:00Z' }] }),
      idea('I-3', { questions: [{ askedAt: '2026-11-09T08:00:00Z', text: 'Gone?' }], state: 'closed' }),
      idea('I-4', { state: 'building', stage: 'deploying', worker: 'idea-4' }),
      idea('I-5', { state: 'building', stage: 'checking' }),
    ],
    ideaFiles: { 'I-1': ['/orch/ideas/inbox/I-1/a.png', '/orch/ideas/progress/I-1/b.mp4'] },
  }));
  assert.deepEqual(q.map(i => [i.key, i.title, i.who, i.recommendation]), [
    ['idea:I-1', 'I-1 · Crafting room', 'asks kingluuu, no timeout', 'the north one'],
    ['deploy:I-4', 'Deploy I-4 · I-4 text', 'idea-4', ''],
  ]);
  assert.deepEqual(q[0].media, ['/orch/ideas/inbox/I-1/a.png', '/orch/ideas/progress/I-1/b.mp4']);
  assert.deepEqual(q[0].answers, { accept: 'I-1: answer the open question with your recommendation.', reject: 'I-1: not your recommendation, ', edit: 'I-1: ' });
  assert.equal(q[1].answers.accept, 'Deploy I-4 now.');
});

test('a PR is queued for merge until a merge line or GitHub says it is done', () => {
  const log = [
    '- 2026-11-09 09:00 open-pr a (autonomous): https://github.com/o/game/pull/5',
    '- 2026-11-09 09:10 open-pr b (by Lucas): https://github.com/o/game/pull/6',
    '- 2026-11-09 09:20 open-pr c (autonomous): https://github.com/o/game/pull/8',
    '- 2026-11-09 09:30 merge game #6 (autonomous): squash-merged abcd1234',
    '- 2026-11-09 09:31 merge game #5 refused: checks pending',
  ].join('\n');
  const q = buildQueue(ledger({
    log, workers: [worker('a', 'sa'), worker('b', 'sb'), worker('c', 'sc')],
    prStates: { 'https://github.com/o/game/pull/8': 'MERGED' },
    reviews: ['2026-11-08-game-orcha.md', '2026-11-09-game-orcha.md', '2026-11-09-game-orcha-judge.md'],
  }));
  assert.deepEqual(q.map(i => [i.key, i.title, i.docs, i.answers.accept]), [
    ['merge:game#5', 'Merge game #5 (a)', ['/orch/reviews/2026-11-09-game-orcha.md'], 'Merge https://github.com/o/game/pull/5 (a).'],
  ]);
});

test('ranked by kind, then oldest first', () => {
  const q = buildQueue(ledger({
    decisions: [decision('D-9', 'open', '2026-11-09 12:00'), decision('D-4', 'open', '2026-11-08 12:00')],
    ideas: [idea('I-1', { questions: [{ askedAt: '2026-11-01T08:00:00Z', text: 'q' }] })],
    workers: [worker('w', 's')],
    feed: [{ ts: '2026-11-07T10:00:00Z', sid: 's', event: 'Stop', cwd: '', prompt: '', msg: 'Want me to push?' }],
  }));
  assert.deepEqual(q.map(i => i.key), ['D-4', 'D-9', 'worker:w', 'idea:I-1']);
});

test('an answer must be the accept text or a finished reject or edit', () => {
  const [d] = buildQueue(ledger({ decisions: [decision('D-1', 'open', '')] }));
  assert.equal(validAnswer(d, 'D-1: yes, go with your recommendation.'), true);
  assert.equal(validAnswer(d, 'D-1: no, wait for the review'), true);
  assert.equal(validAnswer(d, 'D-1: '), false);
  assert.equal(validAnswer(d, 'D-2: yes, go with your recommendation.'), false);
  assert.equal(validAnswer(d, 'Steer x: rm -rf'), false);
});

test('media paths and links are found in prose', () => {
  assert.deepEqual(mediaPaths('see `/a/b c.png`, ~/shots/x.webp and reviews/clip.mp4. Also left/right and foo.png?', '/orch', '/Users/me'),
    ['/Users/me/shots/x.webp', '/orch/reviews/clip.mp4']);
  assert.deepEqual(urls('PR https://github.com/o/r/pull/3, then https://api.runforit.io.'),
    [{ label: 'r #3', url: 'https://github.com/o/r/pull/3' }, { label: 'api.runforit.io', url: 'https://api.runforit.io' }]);
  assert.equal(reviewFor(['2026-11-07-orch-orchthread-titles.md'], 'orch', 'orch/thread-titles'), '2026-11-07-orch-orchthread-titles.md');
});

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
    assert.equal(line, `QUEUE started on http://127.0.0.1:${port} (it was down)`);
    w.kill();
    await new Promise(r => w.once('exit', r));
    assert.equal(await pageUp(), true, 'detached: stopping the watcher leaves the page running');
  } finally {
    w.kill();
    const pid = spawnSync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim();
    for (const p of pid.split('\n').filter(Boolean)) process.kill(Number(p));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the page answers through orch steer into orch\'s pane, logged in log.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-queue-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin); mkdirSync(join(dir, 'decisions'));
    writeFileSync(join(dir, 'decisions', 'D-7.md'), decision('D-7', 'open', '2026-11-09 09:00').md);
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
    const srv = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, '../src/queue-run.ts')], {
      env: { ...process.env, ORCH_DIR: dir, ORCH_QUEUE_PORT: String(port), PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((res, rej) => { srv.stdout.on('data', d => String(d).includes('127.0.0.1') && res()); srv.on('exit', c => rej(new Error(`exit ${c}`))); });
      const base = `http://127.0.0.1:${port}`;
      const q = await (await fetch(`${base}/api/queue`)).json();
      assert.deepEqual(q.items.map((i: any) => i.key), ['D-7']);
      assert.match(await (await fetch(base)).text(), /<title>orch queue<\/title>/);
      assert.equal((await fetch(`${base}/doc?p=${encodeURIComponent(join(dir, 'decisions', 'D-7.md'))}`)).status, 200);
      assert.equal((await fetch(`${base}/doc?p=/etc/passwd`)).status, 404, 'only files the queue names');

      const post = (body: unknown, headers: Record<string, string> = { 'x-orch': 'queue' }) =>
        fetch(`${base}/api/answer`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      assert.equal((await post({ key: 'D-7', text: 'D-7: yes, go with your recommendation.' }, {})).status, 403, 'no custom header, no answer');
      assert.equal((await post({ key: 'D-7', text: 'D-7: yes, go with your recommendation.' }, { 'x-orch': 'queue', origin: 'https://evil.example' })).status, 403);
      assert.equal((await post({ key: 'D-7', text: 'Steer x: something else' })).status, 400);
      const rebound = await new Promise<number>(res => get({ host: '127.0.0.1', port, path: '/api/queue', headers: { host: `evil.example:${port}` } }, r => { r.resume(); res(r.statusCode!); }));
      assert.equal(rebound, 421, 'rebinding host refused');

      const r = await post({ key: 'D-7', text: 'D-7: no, wait for the review' });
      assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
      assert.equal(readFileSync(join(dir, 'prompts.txt'), 'utf8'), 'w1:p1 D-7: no, wait for the review\n');
      assert.match(readFileSync(join(dir, 'log.md'), 'utf8'), /^- \S+ \S+ steer orch: D-7: no, wait for the review$/m);
      const after = await (await fetch(`${base}/api/queue`)).json();
      assert.equal(after.items[0].sent.text, 'D-7: no, wait for the review', 'a second device sees it was answered');
    } finally { srv.kill(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
