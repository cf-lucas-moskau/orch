import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const kit = join(import.meta.dirname, '..', 'docs', 'replicate', 'kit');

test('replicate kit: bus-autorun rejects malformed envelopes and keeps scanning (kit/agent-bus/test_autorun.py)', () => {
  const r = spawnSync('python3', ['-B', join(kit, 'agent-bus', 'test_autorun.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('replicate kit: every shell script parses', () => {
  for (const f of ['check.sh', 'host-services.sh', 'orch-bootstrap.sh', 'remote-control/rc-loop.sh', 'remote-control/rc-bootstrap.sh', 'agent-bus/bus-setup']) {
    const r = spawnSync('bash', ['-n', join(kit, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
