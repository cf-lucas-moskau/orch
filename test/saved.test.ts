import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORCH = join(import.meta.dirname, '..', 'src', 'orch.ts');
const orch = (root: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', ORCH, ...args], { encoding: 'utf8', env: { ...process.env, ORCH_DIR: root } });

const pad = (n: number) => String(n).padStart(2, '0');
const stampOf = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

test('saved --prune lists stale folders and deletes nothing; --yes removes only the stale folders inside saved/', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-saved-'));
  const saved = join(root, 'saved'), outside = join(root, 'outside');
  const stale = join(saved, 'anim-flake-20200101-1200'), fresh = join(saved, `weaver-${stampOf(new Date())}`), hand = join(saved, 'hand-made');
  for (const d of [join(stale, 'docs', 'alpha'), fresh, hand, outside, join(root, 'twin-20200101-1200')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(stale, 'docs', 'alpha', 'shot.png'), 'png');
  writeFileSync(join(fresh, 'shot.png'), 'png');
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  // A stale-looking name that is a link out of saved/: never followed, never deleted.
  symlinkSync(outside, join(saved, 'link-20200101-1200'));
  const all = [stale, fresh, hand, join(saved, 'link-20200101-1200'), join(outside, 'keep.txt'), join(root, 'twin-20200101-1200')];

  const preview = orch(root, 'saved', '--prune');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /anim-flake-20200101-1200\n\n1 folders in .* older than 3 days, .*needs the user's OK/);
  assert.doesNotMatch(preview.stdout, /weaver|hand-made|link-|twin-/);
  for (const p of all) assert.ok(existsSync(p), `preview kept ${p}`);

  assert.match(orch(root, 'saved', '--yes').stderr, /usage: orch saved --prune \[--yes\]/);
  assert.match(orch(root, 'saved', '--prune', '--force').stderr, /usage/);
  assert.ok(existsSync(stale), 'a bad flag deletes nothing');

  const yes = orch(root, 'saved', '--prune', '--yes');
  assert.equal(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /^deleted 1 folders/);
  assert.ok(!existsSync(stale));
  for (const p of all.slice(1)) assert.ok(existsSync(p), `--yes kept ${p}`);
  assert.match(readFileSync(join(root, 'log.md'), 'utf8'), /saved --prune --yes: deleted 1 folders .*anim-flake-20200101-1200/);
  assert.match(orch(root, 'saved', '--prune').stdout, /nothing in .* is older than 3 days/);
});
