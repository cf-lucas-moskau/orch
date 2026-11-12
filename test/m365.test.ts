import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('scripts/m365.py passes its fixture tests (test/m365_test.py, no network)', () => {
  const r = spawnSync('python3', ['-I', join(import.meta.dirname, 'm365_test.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
