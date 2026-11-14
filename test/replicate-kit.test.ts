import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const kit = join(import.meta.dirname, '..', 'docs', 'replicate', 'kit');

test('replicate kit: bus-autorun rejects malformed envelopes and keeps scanning (kit/agent-bus/test_autorun.py)', () => {
  const r = spawnSync('python3', ['-B', join(kit, 'agent-bus', 'test_autorun.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('replicate kit: every shell script parses', () => {
  for (const f of ['check.sh', 'host-services.sh','remote-control/rc-loop.sh', 'remote-control/rc-bootstrap.sh', 'agent-bus/bus-setup',
    'pstack.sh', 'claude-settings.sh', 'statusline.sh', 'media-relay/screenshot-catcher-install.sh']) {
    const r = spawnSync('bash', ['-n', join(kit, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

// Runs a media-relay hook with a JSON event on stdin; returns its additionalContext ('' when silent) and how long it took.
function hook(script: string, event: object, env: Record<string, string>) {
  const t = Date.now();
  const r = spawnSync('python3', ['-B', join(kit, 'media-relay', script)], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return { said: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string : '', ms: Date.now() - t };
}

test('replicate kit: remote-paths acts only on main-Mac screenshot temp paths, never waits on anything else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const shots = join(dir, 'Screenshots');
  mkdirSync(shots);
  writeFileSync(join(shots, 'a.png'), 'x');
  const env = { REMOTE_PATHS_DIR: shots, REMOTE_PATHS_WAIT: '2' };
  const run = (prompt: string) => hook('remote-paths.py', { prompt }, env);
  // This Mac's own screenshot folder, when its temp dir has the macOS shape: not the main Mac's.
  const tmp = (process.env.TMPDIR ?? '').replace(/\/$/, '');
  const own = /^(\/private)?\/var\/folders\/[^/]+\/[^/]+\/T$/.test(tmp) ? join(tmp, 'TemporaryItems', `NSIRD_screencaptureui_rp${process.pid}`) : '';
  if (own) mkdirSync(own, { recursive: true });

  for (const prompt of ['create /tmp/report.pdf', 'see https://example.com/shots/a.png and http://x.io/var/folders/q/r/T/TemporaryItems/NSIRD_screencaptureui_Q1/a.png',
    `write the logo to ${dir}/code/app/public/logo.png`, '/var/folders/xy/abc/T/missing.png', '/private/var/folders/xy/abc/T/out/report.pdf',
    ...own ? [`${own}/gone.png`, `${own.replace(/^\/private/, '')}/gone.png`] : []]) {
    const r = run(prompt);
    assert.equal(r.said, '', prompt);
    assert.ok(r.ms < 1500, `${prompt} waited ${r.ms} ms`);
  }
  for (const prefix of ['', '/private']) {
    const pasted = run(`look at '${prefix}/var/folders/xy/abc/T/TemporaryItems/NSIRD_screencaptureui_Q1/a.png'`);
    assert.match(pasted.said, new RegExp(`synced copy here is ${shots}/a\\.png`));
  }
  const missing = run('/var/folders/xy/abc/T/TemporaryItems/NSIRD_screencaptureui_Q1/nope.png');
  assert.match(missing.said, /no synced copy named nope\.png/);
  assert.ok(missing.ms >= 1900, 'waits for a screenshot still syncing');
  if (own) rmSync(own, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

test('replicate kit: share-images names copies by content, never overwrites, prunes at most hourly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'si-'));
  const shared = join(dir, 'AgentImages'), marker = join(dir, 'sender');
  mkdirSync(join(dir, 'w1')); mkdirSync(join(dir, 'w2'));
  writeFileSync(marker, '');
  const one = join(dir, 'w1', 'screenshot.png'), two = join(dir, 'w2', 'screenshot.png');
  writeFileSync(one, 'first'); writeFileSync(two, 'second');
  const env = { AGENT_IMAGES_DIR: shared, AGENT_IMAGES_MARKER: marker };
  const copyOf = (src: string) => /synced copy is at (\S+), which/.exec(hook('share-images.py', { tool_input: { file_path: src } }, env).said)![1];

  const a = copyOf(one), b = copyOf(two);
  assert.notEqual(a, b, 'same name, different images: two copies');
  assert.equal(readFileSync(a, 'utf8'), 'first');
  assert.equal(readFileSync(b, 'utf8'), 'second');
  assert.equal(copyOf(one), a, 'same image again: same path');
  assert.deepEqual(readdirSync(shared).filter(f => f.startsWith('.part-')), [], 'no temp files left');

  const old = join(shared, 'old.png');
  writeFileSync(old, 'x');
  const past = new Date(Date.now() - 20 * 86400_000);
  utimesSync(old, past, past);
  copyOf(two);
  assert.ok(existsSync(old), 'pruned within the hour already: left alone');
  utimesSync(join(shared, '.pruned'), past, past);
  copyOf(two);
  assert.ok(!existsSync(old), 'an hour later: pruned');
  assert.equal(hook('share-images.py', { tool_input: { file_path: one } }, { ...env, AGENT_IMAGES_MARKER: join(dir, 'none') }).said, '', 'silent without the marker');
  rmSync(dir, { recursive: true, force: true });
});
