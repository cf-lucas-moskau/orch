// One-time setup: checks tools, creates the local ledger, installs the feed hook for Claude (and Codex),
// and with --nightly the macOS learning jobs. Safe to rerun; it backs up any settings file before changing it.
// Usage: npm run setup [-- --nightly] [-- --dry-run]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const home = homedir();
const dry = process.argv.includes('--dry-run');
const nightly = process.argv.includes('--nightly');
const has = (bin: string) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const say = (s: string) => console.log(s);
const write = (path: string, text: string) => { if (!dry) writeFileSync(path, text); };

// 1. Tools
const [major, minor] = process.versions.node.split('.').map(Number);
const tools: [string, boolean, string][] = [
  ['node 22.6+', major > 22 || (major === 22 && minor >= 6), 'https://nodejs.org'],
  ['claude', has('claude'), 'https://claude.com/claude-code'],
  ['herdr', has('herdr'), 'brew install herdr  (https://herdr.dev)'],
  ['jq', has('jq'), 'brew install jq'],
  ['git', has('git'), 'xcode-select --install'],
];
const optional: [string, boolean, string][] = [
  ['gh', has('gh'), 'brew install gh; needed for the PR routine'],
  ['codex', has('codex'), 'npm i -g @openai/codex; needed for Codex workers and bimodel reviews'],
];
say('Tools');
for (const [name, ok, hint] of tools) say(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `  -> ${hint}`}`);
for (const [name, ok, hint] of optional) say(`  ${ok ? '✓' : '·'} ${name}${ok ? '' : ` (optional)  -> ${hint}`}`);
if (tools.some(t => !t[1])) { say('\nInstall the missing tools above, then run npm run setup again.'); process.exit(1); }

// 2. Local ledger: never overwrites what exists.
say('\nLedger');
for (const d of ['feed', 'decisions', 'plans', 'notes', 'reviews', 'learned', 'briefs']) if (!dry) mkdirSync(join(root, d), { recursive: true });
const seed: [string, () => string][] = [
  ['local.md', () => readFileSync(join(root, 'local.example.md'), 'utf8')],
  ['projects.md', () => readFileSync(join(root, 'projects.example.md'), 'utf8')],
  ['workers.json', () => '[]\n'],
  ['log.md', () => '# log\n\n'],
];
for (const [file, text] of seed) {
  if (existsSync(join(root, file))) { say(`  ✓ ${file} kept`); continue; }
  write(join(root, file), text());
  say(`  + ${file}`);
}

say('\nherdr');
// 3. herdr's own agent-state hooks, so herdr knows when a session works, waits or is blocked.
const herdrStatus = spawnSync('herdr', ['integration', 'status'], { encoding: 'utf8' }).stdout;
for (const agent of ['claude', ...(has('codex') ? ['codex'] : [])]) {
  if (new RegExp(`^${agent}: current`, 'm').test(herdrStatus)) { say(`  ✓ herdr ${agent} integration`); continue; }
  if (!dry) spawnSync('herdr', ['integration', 'install', agent], { stdio: 'inherit' });
  say(`  + herdr ${agent} integration`);
}

// 4. The feed hook. Merged into existing settings; an entry that already runs orch-feed.sh is left alone.
const hook = join(root, 'hooks', 'orch-feed.sh');
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
type Hooks = Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
function installHooks(file: string, events: string[], command: string, label: string) {
  const existed = existsSync(file);
  const settings = existed ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const hooks: Hooks = settings.hooks ?? {};
  const missing = events.filter(e => !(hooks[e] ?? []).some(g => g.hooks.some(h => h.command.includes('orch-feed.sh'))));
  if (!missing.length) { say(`  ✓ ${label} feed hook`); return; }
  for (const e of missing) (hooks[e] ??= []).push({ hooks: [{ type: 'command', command, timeout: 5 }] });
  settings.hooks = hooks;
  if (!dry) {
    mkdirSync(join(file, '..'), { recursive: true });
    if (existsSync(file)) copyFileSync(file, `${file}.bak-orch`);
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  }
  say(`  + ${label} feed hook on ${missing.join(', ')}${existed ? ` (backup: ${file}.bak-orch)` : ''}`);
}
say('\nHooks');
installHooks(join(home, '.claude', 'settings.json'), ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'],
  `ORCH_DIR=${q(root)} bash ${q(hook)}; exit 0`, 'Claude');
if (has('codex')) installHooks(join(home, '.codex', 'hooks.json'), ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'Stop', 'SessionEnd'],
  `ORCH_DIR=${q(root)} ORCH_AGENT=codex /bin/bash ${q(hook)}`, 'Codex');

// 5. Nightly learning jobs (macOS launchd): reflect at 23:40, weekly memory prune on Sundays at 22:10.
if (nightly) {
  say('\nNightly jobs');
  if (process.platform !== 'darwin') say('  · launchd is macOS only; schedule `npm run -s reflect` (nightly) and `npm run -s reflect -- --weekly` with cron instead.');
  else {
    const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const jobs = [
      { label: 'orch.reflect', cmd: 'npm run -s reflect', when: '<key>Hour</key><integer>23</integer><key>Minute</key><integer>40</integer>' },
      { label: 'orch.prune', cmd: 'npm run -s reflect -- --weekly', when: '<key>Weekday</key><integer>0</integer><key>Hour</key><integer>22</integer><key>Minute</key><integer>10</integer>' },
    ];
    for (const j of jobs) {
      const log = join(home, 'Library', 'Logs', `${j.label}.log`);
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${j.label}</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>${x(`cd ${q(root)} && ${j.cmd}`)}</string></array>
  <key>StartCalendarInterval</key><dict>${j.when}</dict>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(process.env.PATH ?? '/usr/bin:/bin')}</string></dict>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
      const dst = join(home, 'Library', 'LaunchAgents', `${j.label}.plist`);
      if (!dry) {
        mkdirSync(join(dst, '..'), { recursive: true });
        spawnSync('launchctl', ['bootout', `gui/${process.getuid!()}`, dst]);
        writeFileSync(dst, plist);
        spawnSync('launchctl', ['bootstrap', `gui/${process.getuid!()}`, dst], { stdio: 'inherit' });
      }
      say(`  + ${j.label}`);
    }
  }
}

say(`\nDone${dry ? ' (dry run, nothing written)' : ''}. Next:
  1. Edit local.md (your name, your cap) and projects.md (your repos and their test commands).
  2. Start herdr, add a workspace named orch, and in it run:  cd ${root} && npm start
  3. Say "what's going on". Type /deck for the live pane.
Sessions started before setup are not in the feed until you restart them.`);
