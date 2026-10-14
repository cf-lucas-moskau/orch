import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hook = join(import.meta.dirname, '..', 'hooks', 'orch-feed.sh');
const run = (dir: string, payload: object | string) =>
  execFileSync('bash', [hook], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), env: { ...process.env, ORCH_DIR: dir } });
const lines = (dir: string) => {
  const f = readdirSync(join(dir, 'feed'));
  return f.flatMap(n => readFileSync(join(dir, 'feed', n), 'utf8').trim().split('\n')).map(l => JSON.parse(l));
};
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'orch-')); return d; };

test('appends one compact line per event', () => {
  const d = fresh();
  run(d, { session_id: 's1', hook_event_name: 'UserPromptSubmit', cwd: '/x', prompt: 'first line\nsecond' });
  run(d, { session_id: 's1', hook_event_name: 'Notification', cwd: '/x', message: 'needs permission' });
  const [a, b] = lines(d);
  assert.equal(a.sid, 's1'); assert.equal(a.event, 'UserPromptSubmit'); assert.equal(a.prompt, 'first line');
  assert.match(a.ts, /^\d{4}-\d\d-\d\dT/);
  assert.equal(b.msg, 'needs permission');
});

test('Stop takes the last assistant text from the transcript', () => {
  const d = fresh();
  const tp = join(d, 't.jsonl');
  writeFileSync(tp, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'earlier' }] } },
    { type: 'user', message: { content: 'hi' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'All tests green.' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n');
  run(d, { session_id: 's2', hook_event_name: 'Stop', cwd: '/x', transcript_path: tp });
  assert.equal(lines(d)[0].msg, 'All tests green.');
});

test('prefers last_assistant_message when the payload has it', () => {
  const d = fresh();
  run(d, { session_id: 's3', hook_event_name: 'Stop', cwd: '/x', last_assistant_message: 'from payload' });
  assert.equal(lines(d)[0].msg, 'from payload');
});

test('does nothing and exits 0 when the orch dir is missing', () => {
  const d = join(fresh(), 'nope');
  run(d, { session_id: 's4', hook_event_name: 'Stop' });
  assert.ok(!existsSync(d));
});

test('exits 0 on garbage input', () => {
  const d = fresh(); mkdirSync(join(d, 'feed'));
  run(d, 'not json');
});

test('keeps the end of long messages in tail, where questions usually are', () => {
  const d = fresh();
  const long = 'x'.repeat(1000) + ' Should I push?';
  run(d, { session_id: 's5', hook_event_name: 'Stop', cwd: '/x', last_assistant_message: long });
  const [e] = lines(d);
  assert.equal(e.msg.length, 400);
  assert.ok(e.tail.endsWith('Should I push?'));
  assert.equal(e.tail.length, 300);
});

test('codex permission requests land as blocked-style notifications tagged codex', () => {
  const d = fresh();
  execFileSync('bash', [hook], {
    input: JSON.stringify({ session_id: 'c1', hook_event_name: 'PermissionRequest', cwd: '/x', turn_id: 't', tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'delete build dir' } }),
    env: { ...process.env, ORCH_DIR: d, ORCH_AGENT: 'codex' },
  });
  execFileSync('bash', [hook], {
    input: JSON.stringify({ session_id: 'c1', hook_event_name: 'Stop', cwd: '/x', last_assistant_message: 'Done. Push it?' }),
    env: { ...process.env, ORCH_DIR: d, ORCH_AGENT: 'codex' },
  });
  const [a, b] = lines(d);
  assert.equal(a.event, 'Notification');
  assert.equal(a.msg, 'Codex needs your permission: delete build dir');
  assert.equal(a.agent, 'codex');
  assert.equal(b.msg, 'Done. Push it?');
});
