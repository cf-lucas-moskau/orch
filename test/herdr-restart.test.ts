import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'herdr-restart.sh');

// --dry against a fake herdr first on PATH: the script reads agent and workspace lists and changes nothing.
function dry(agents: object[]) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-restart-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ result: { agents } }));
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'code' }, { workspace_id: 'w9', label: 'orch' }] } }));
  writeFileSync(join(dir, 'herdr'), `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1 $2" in
  "agent list") cat '${dir}/agents.json' ;;
  "workspace list") cat '${dir}/workspaces.json' ;;
  *) echo '{"result":{"type":"ok"}}' ;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_DIR: dir };
  delete (env as any).ORCH_SID;
  const r = spawnSync('/bin/bash', [SCRIPT, '--dry'], { env, encoding: 'utf8', timeout: 30_000 });
  const calls = existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8') : '';
  return { ...r, out: (r.stdout + r.stderr).replace(/^\S+ \S+ /gm, ''), calls };
}
const agent = (name: string, ws: string, sid: string, cwd: string, kind = 'claude') =>
  ({ name, workspace_id: ws, pane_id: `${ws}:p1`, agent: kind, cwd, agent_status: 'idle', agent_session: sid ? { value: sid } : undefined });

test('orch is found by its workspace label, leads come back through lead start, the rest resume', () => {
  const r = dry([agent('', 'w9', 'orch-sid', '/o'), agent('lead-evrloot', 'w4', 'lead-sid', '/o'), agent('idea-74', 'w5', 'w-sid', '/wt/idea-74')]);
  assert.equal(r.status, 0, r.out + r.stderr);
  assert.match(r.out, /would run: herdr server stop/);
  assert.match(r.out, /would open \/o \(orch\) and run: claude --resume orch-sid -n orch --remote-control orch --plugin-dir \.\/mod/);
  assert.match(r.out, /would run: npm run -s orch -- lead start evrloot/);
  assert.doesNotMatch(r.out, /claude --resume lead-sid/);
  assert.match(r.out, /would open \/wt\/idea-74 \(idea-74\) and run: claude --resume w-sid/);
  assert.doesNotMatch(r.calls, /server stop|workspace (create|close)|pane run/, 'a dry run changes nothing');
});

test('a live agent without a session id stops the restart before the server goes down', () => {
  const r = dry([agent('', 'w9', 'orch-sid', '/o'), agent('idea-80', 'w6', '', '/wt/idea-80', 'codex')]);
  assert.equal(r.status, 5);
  assert.match(r.out, /aborting, these agents have no session id and would be lost:\n {2}idea-80 codex \/wt\/idea-80/);
  assert.doesNotMatch(r.out, /server stop/);
});

test('without ORCH_SID and no orch workspace, nothing happens', () => {
  const r = dry([agent('idea-74', 'w5', 'w-sid', '/wt/idea-74')].map(a => ({ ...a, workspace_id: 'w5' })));
  assert.equal(r.status, 3);
  assert.match(r.out, /no orch session found/);
});
