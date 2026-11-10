import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'herdr-restart.sh');

// A fake herdr and launchctl first on PATH: the script reads agent and workspace lists, and every call is recorded.
// --dry changes nothing; a real run only gets as far as a server stop the fake refuses (failStop).
function dry(agents: object[], o: { real?: boolean; stopOk?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-restart-'));
  writeFileSync(join(dir, 'agents.json'), JSON.stringify({ result: { agents } }));
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'code' }, { workspace_id: 'w9', label: 'orch' }] } }));
  writeFileSync(join(dir, 'herdr'), `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1 $2" in
  "agent list") cat '${dir}/agents.json' ;;
  "workspace list") cat '${dir}/workspaces.json' ;;
  "server stop") ${o.stopOk ? 'exit 0' : 'echo "server stop refused" >&2; exit 1'} ;;
  "workspace create") echo '{"result":{"root_pane":{"pane_id":"new:p1"}}}' ;;
  "pane run") cat > /dev/null ;;
  *) echo '{"result":{"type":"ok"}}' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> '${dir}/calls'\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, ORCH_DIR: dir, START: '00:00', DEADLINE: '23:59', SETTLE_S: '0', WAKE_S: '0' };
  delete (env as any).ORCH_SID;
  const r = spawnSync('/bin/bash', o.real ? [SCRIPT] : [SCRIPT, '--dry'], { env, encoding: 'utf8', timeout: 30_000 });
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
  assert.doesNotMatch(r.out, /claude --resume lead-sid|would run: npm run/, 'leads are not resumed by the script');
  assert.match(r.out, /would prompt orch: .*update each worker's pane and workspace in workers\.json.* Only after workers\.json is updated, run npm run -s orch -- lead start evrloot/);
  assert.match(r.out, /would open \/wt\/idea-74 \(idea-74\) and run: claude --resume w-sid/);
  assert.doesNotMatch(r.calls, /server stop|workspace (create|close)|pane run/, 'a dry run changes nothing');
});

test('a real run resumes every session even when a command reads stdin, and leaves leads to orch', () => {
  const r = dry([agent('', 'w9', 'orch-sid', '/o'), agent('a', 'w2', 'a-sid', '/a'), agent('lead-evrloot', 'w4', 'lead-sid', '/o'), agent('b', 'w3', 'b-sid', '/b'), agent('c', 'w5', 'c-sid', '/c')], { real: true, stopOk: true });
  assert.equal(r.status, 0, r.out);
  const runs = r.calls.split('\n').filter(c => c.startsWith('pane run'));
  assert.deepEqual(runs.map(c => c.split(' ').slice(3).join(' ')), [
    'claude --resume orch-sid -n orch --remote-control orch --plugin-dir ./mod', 'claude --resume a-sid', 'claude --resume b-sid', 'claude --resume c-sid',
  ]);
  assert.match(r.calls, /agent prompt new:p1 .*lead start evrloot/);
});

test('a live agent without a session id stops the restart before the server goes down', () => {
  const r = dry([agent('', 'w9', 'orch-sid', '/o'), agent('idea-80', 'w6', '', '/wt/idea-80', 'codex')]);
  assert.equal(r.status, 5);
  assert.match(r.out, /aborting, these agents have no session id and would be lost:\n {2}idea-80 codex \/wt\/idea-80/);
  assert.doesNotMatch(r.out, /server stop/);
});

test('a failed server stop ends the run before anything is restarted or resumed', () => {
  const r = dry([agent('', 'w9', 'orch-sid', '/o'), agent('idea-74', 'w5', 'w-sid', '/wt/idea-74')], { real: true });
  assert.equal(r.status, 6, r.out);
  assert.match(r.out, /herdr server stop failed, nothing restarted: server stop refused/);
  assert.match(r.calls, /server stop/);
  assert.doesNotMatch(r.calls, /^server$|server\n|workspace create|pane run/m);
});

test('without ORCH_SID and no orch workspace, nothing happens', () => {
  const r = dry([agent('idea-74', 'w5', 'w-sid', '/wt/idea-74')].map(a => ({ ...a, workspace_id: 'w5' })));
  assert.equal(r.status, 3);
  assert.match(r.out, /no orch session found/);
});
