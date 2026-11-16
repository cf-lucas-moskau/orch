import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATHS, secretMentions, secretTouches } from '../src/dispatch.ts';

const use = (name: string, input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const say = (text: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } });

test('a tool call that reads data/admin is caught, through any interpreter', () => {
  const t = [use('Bash', { command: `node -e "require('fs').readFileSync('data/admin/admin-partner.json')"` }), use('Read', { file_path: '/x/README.md' })].join('\n');
  const hits = secretTouches(t, SECRET_PATHS['evrloot-next']);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /^Bash: /);
});

test('mentioning the rule in text, or a repo without secret paths, passes', () => {
  assert.deepEqual(secretTouches(say('never touch data/admin'), ['data/admin']), []);
  assert.deepEqual(secretTouches(use('Bash', { command: 'cat data/admin/x' }), []), []);
  assert.deepEqual(secretTouches('not json tool_use\n', ['data/admin']), []);
});

test('writing the rule into a doc passes; code naming the path warns instead of failing', () => {
  const doc = use('Edit', { file_path: '/w/CLAUDE.md', old_string: 'a', new_string: 'Workers never touch data/admin.' });
  assert.deepEqual(secretTouches(doc, ['data/admin']), []);
  assert.deepEqual(secretMentions(doc, ['data/admin']), []);
  const code = use('Write', { file_path: '/w/tools/perf/stack.sh', content: "test -e data/admin && exit 1" });
  assert.deepEqual(secretTouches(code, ['data/admin']), []);
  assert.equal(secretMentions(code, ['data/admin']).length, 1);
  assert.equal(secretTouches(use('Write', { file_path: '/r/data/admin/x.json', content: '{}' }), ['data/admin']).length, 1);
  assert.equal(secretTouches(use('Grep', { pattern: 'token', path: '/r/data/admin' }), ['data/admin']).length, 1);
});

test('searching for the path as a pattern warns; searching inside it or reading it fails', () => {
  const t = (command: string) => use('Bash', { command });
  assert.deepEqual(secretTouches(t(`grep -rn "data/admin" apps/web tools/alpha`), ['data/admin']), []);
  assert.equal(secretMentions(t(`grep -rn "data/admin" apps/web tools/alpha`), ['data/admin']).length, 1);
  assert.deepEqual(secretTouches(t(`rg -n 'data/admin/admin.json|ADMIN_KEY' apps tools`), ['data/admin']), []);
  assert.deepEqual(secretTouches(use('Grep', { pattern: 'data/admin', path: '/w/apps' }), ['data/admin']), []);
  assert.equal(secretTouches(t(`grep -rn token data/admin`), ['data/admin']).length, 1);
  assert.equal(secretTouches(t(`grep "token" "data/admin/a.json"`), ['data/admin']).length, 1);
  assert.equal(secretTouches(t(`grep -rn data/admin apps`), ['data/admin']).length, 1);
  assert.equal(secretTouches(t(`grep -l "x" apps | xargs cat "data/admin/a.json"`), ['data/admin']).length, 1);
  assert.equal(secretTouches(t(`cat "data/admin/a.json"`), ['data/admin']).length, 1);
});
