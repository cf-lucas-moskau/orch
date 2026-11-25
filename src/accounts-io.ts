// IO for src/accounts.ts: the keychain, the usage endpoint, the swap and the login panes.
//
// Every organization has a store: a config dir under ~/.orch-accounts/<name> whose keychain item holds that seat's
// login. The live item ("Claude Code-credentials") holds a copy of the active seat's login. A swap saves the live item
// back to the active seat's store first (Claude rotates refresh tokens), then copies the target's store into it.
// While a seat is active its store is never used, so the two copies never refresh against each other.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { EMPTY, LIVE_SERVICE, loginUrl, parseLogin, parseUsage, serviceSuffix, type Account, type AccountsState, type Login, type Usage } from './accounts.ts';

export const STORES = process.env.ORCH_ACCOUNTS_HOME ?? join(homedir(), '.orch-accounts');
const CLAUDE_JSON = process.env.ORCH_CLAUDE_JSON ?? join(homedir(), '.claude.json');
// Tests point this at a throwaway item; nothing else should.
const LIVE = process.env.ORCH_LIVE_SERVICE ?? LIVE_SERVICE;
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const user = () => process.env.USER || userInfo().username;

export const storeDir = (name: string) => join(STORES, name);
export const serviceFor = (dir: string) => serviceSuffix(createHash('sha256').update(dir.normalize('NFC')).digest('hex'));

// accounts/config.json: the seats orch may switch between. accounts/state.json: numbers and rate limits.
const file = (root: string, f: string) => join(root, 'accounts', f);
const readJson = (p: string, fallback: any) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };
const writeJson = (p: string, v: unknown) => {
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  renameSync(tmp, p);
};
export const loadAccounts = (root: string): Account[] => readJson(file(root, 'config.json'), { accounts: [] }).accounts ?? [];
export const saveAccounts = (root: string, accounts: Account[]) => writeJson(file(root, 'config.json'), { accounts });
export const loadState = (root: string): AccountsState => ({ ...EMPTY, ...readJson(file(root, 'state.json'), {}) });
export const saveState = (root: string, s: AccountsState) => writeJson(file(root, 'state.json'), s);

// The keychain through the security CLI. Writes go through stdin with the value hex-encoded (-X), so no token ever
// appears in a process list and nothing needs quoting.
export function readItem(service: string): string | undefined {
  const r = spawnSync('security', ['find-generic-password', '-a', user(), '-s', service, '-w'], { encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 ? r.stdout.trim() : undefined;
}
export function writeItem(service: string, value: string): boolean {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const r = spawnSync('security', ['-i'], { input: `add-generic-password -U -a "${user()}" -s "${service}" -X "${hex}"\n`, encoding: 'utf8', timeout: 15_000 });
  return r.status === 0 && readItem(service) === value;
}
export const liveLogin = () => parseLogin(readItem(LIVE));
export const storeLogin = (a: Account) => parseLogin(readItem(serviceFor(a.dir)));

// Which seat the live login belongs to.
export const activeName = (accounts: Account[], live = liveLogin()) => accounts.find(a => a.orgId === live?.organizationUuid)?.name;

export async function fetchUsage(token: string, now = Date.now()): Promise<{ usage?: Usage; status: number }> {
  try {
    const r = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'orch-accounts' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return { status: r.status };
    return { usage: parseUsage(await r.json(), now), status: r.status };
  } catch { return { status: 0 }; }
}

// claude with a config dir (undefined: the live login), off the event loop.
function claude(dir: string | undefined, args: string[], ms = 60_000): Promise<{ code: number; out: string }> {
  return new Promise(res => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    if (dir) env.CLAUDE_CONFIG_DIR = dir; else delete env.CLAUDE_CONFIG_DIR;
    const c = spawn('claude', args, { env, cwd: dir ?? homedir() });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), ms);
    c.on('error', e => { clearTimeout(t); res({ code: -1, out: e.message }); });
    c.on('close', code => { clearTimeout(t); res({ code: code ?? -1, out }); });
  });
}
export async function authStatus(dir?: string): Promise<{ orgId?: string; orgName?: string; loggedIn?: boolean; email?: string } | undefined> {
  const r = await claude(dir, ['auth', 'status', '--json'], 30_000);
  try { return JSON.parse(r.out.slice(r.out.indexOf('{'))); } catch { return undefined; }
}

// A standby seat's access token lives about 8 hours. When it has run out, let Claude refresh it in the store: first
// auth status, then one tiny headless prompt if that did not refresh it.
export async function freshStoreLogin(a: Account, now = Date.now()): Promise<Login | undefined> {
  const ok = (l?: Login) => l && l.expiresAt > now + 5 * 60_000;
  let l = storeLogin(a);
  if (ok(l)) return l;
  await authStatus(a.dir);
  l = storeLogin(a);
  if (ok(l)) return l;
  await claude(a.dir, ['-p', 'Reply with: ok', '--model', 'haiku'], 90_000);
  l = storeLogin(a);
  return ok(l) ? l : undefined;
}

// Reads one seat's numbers: the active seat with the live login, the others with their store.
export async function readUsage(a: Account, active: string | undefined): Promise<{ usage?: Usage; error?: string }> {
  const l = a.name === active ? liveLogin() : await freshStoreLogin(a);
  if (!l) return { error: a.name === active ? 'no live login' : `${a.name}: its stored login could not be refreshed` };
  if (a.name === active && l.expiresAt <= Date.now()) return {}; // a running session refreshes it in a moment
  const r = await fetchUsage(l.accessToken);
  return r.usage ? { usage: r.usage } : { error: `${a.name}: usage endpoint answered ${r.status || 'nothing'}` };
}

// The org block Claude Code shows in /status. Best effort: running sessions also write this file.
function setOauthAccount(fromDir: string) {
  const src = readJson(join(fromDir, '.claude.json'), {}).oauthAccount;
  if (!src) return;
  const cur = readJson(CLAUDE_JSON, undefined);
  if (!cur) return;
  writeJson(CLAUDE_JSON, { ...cur, oauthAccount: src });
}

// Moves the live login from one seat to another. Checks before every write; rolls back if the result does not read
// back as the target seat. Returns undefined on success, else why nothing changed.
// What claude reports after a swap: the org it shows, but only if the live token also works against the API.
async function checkLive(): Promise<string | undefined> {
  const l = liveLogin();
  if (!l || (await fetchUsage(l.accessToken)).status !== 200) return 'a live token the API refuses';
  return (await authStatus())?.orgId;
}

export async function swap(from: Account, to: Account, now = Date.now(), liveOrg = checkLive, claudeJson = true): Promise<string | undefined> {
  const rawLive = readItem(LIVE), live = parseLogin(rawLive);
  if (!rawLive || !live) return 'no live login to save';
  if (live.organizationUuid !== from.orgId) return `the live login is not ${from.name}`;
  // A refresh is about due: a session may write a new live token any second, which this swap would lose.
  if (live.expiresAt - now < 3 * 60_000) return 'the live token is about to be refreshed, trying again next minute';
  const rawTarget = readItem(serviceFor(to.dir)), target = parseLogin(rawTarget);
  if (!rawTarget || !target) return `${to.name} has no stored login (orch account login ${to.name})`;
  if (target.organizationUuid !== to.orgId) return `${to.name}'s stored login belongs to another organization`;
  if (target.refreshTokenExpiresAt && target.refreshTokenExpiresAt <= now) return `${to.name}'s stored login has expired (orch account login ${to.name})`;
  if (!writeItem(serviceFor(from.dir), rawLive)) return `could not save ${from.name}'s login to its store`;
  if (!writeItem(LIVE, rawTarget)) {
    writeItem(LIVE, rawLive);
    return 'could not write the live login; left it as it was';
  }
  // claude auth status reads the org from ~/.claude.json, so that moves first.
  if (claudeJson) setOauthAccount(to.dir);
  const org = await liveOrg();
  if (org !== to.orgId) {
    writeItem(LIVE, rawLive);
    if (claudeJson) setOauthAccount(from.dir);
    return `after the swap claude reported ${org ?? 'no login'} instead of ${to.name}; rolled back to ${from.name}`;
  }
  return undefined;
}

// Login, step 1: claude auth login in a hidden herdr pane on the seat's store; returns the link to open in a normal
// browser (claude.ai's bot check stops automated browsers). Step 2, finishLogin, pastes the code the browser shows.
const loginRec = (root: string, name: string) => file(root, `login-${name}.json`);
function herdr(args: string[]) {
  const r = spawnSync('herdr', args, { encoding: 'utf8', timeout: 20_000 });
  return r.stdout || r.stderr || '';
}
export const email = () => readJson(CLAUDE_JSON, {}).oauthAccount?.emailAddress as string | undefined;

export async function startLogin(root: string, name: string): Promise<{ url?: string; error?: string }> {
  const dir = storeDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ws = herdr(['workspace', 'create', '--cwd', dir, '--label', `login-${name}`, '--no-focus']);
  let pane: string | undefined;
  try { pane = JSON.parse(ws).result.root_pane.pane_id; } catch { return { error: `herdr: ${ws.trim().slice(0, 200)}` }; }
  const mail = email();
  const cmd = `BROWSER=/usr/bin/true CLAUDE_CONFIG_DIR='${dir}' claude auth login --claudeai${mail ? ` --email '${mail}'` : ''}`;
  herdr(['pane', 'run', pane!, cmd]);
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const url = loginUrl(herdr(['pane', 'read', pane!, '--source', 'recent-unwrapped']));
    if (url) {
      writeJson(loginRec(root, name), { pane, workspace: JSON.parse(ws).result.workspace?.workspace_id, dir, started: Date.now() });
      return { url };
    }
  }
  return { error: `no login link appeared in pane ${pane}` };
}

export async function finishLogin(root: string, name: string, code: string): Promise<{ account?: Account; error?: string }> {
  const rec = readJson(loginRec(root, name), undefined);
  if (!rec?.pane) return { error: `no login running for ${name}; start one with orch account login ${name}` };
  herdr(['pane', 'send-text', rec.pane, code.trim()]);
  herdr(['pane', 'send-keys', rec.pane, 'Enter']);
  let out = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    out = herdr(['pane', 'read', rec.pane, '--source', 'recent-unwrapped']);
    if (/Login successful|error|failed|invalid/i.test(out.split('Paste code here').at(-1) ?? '')) break;
  }
  const st = await authStatus(rec.dir);
  if (!st?.loggedIn || !st.orgId) return { error: `login did not finish: ${out.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300)}` };
  if (rec.workspace) herdr(['workspace', 'close', rec.workspace]);
  return { account: { name, orgId: st.orgId, orgName: st.orgName ?? name, dir: rec.dir } };
}

// The seat that is live right now gets a store from the live login, so it can be switched back to later.
export function adoptLive(name: string, orgId: string, orgName: string): Account | string {
  const raw = readItem(LIVE), live = parseLogin(raw);
  if (!raw || live?.organizationUuid !== orgId) return 'the live login is not that organization';
  const dir = storeDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const oauthAccount = readJson(CLAUDE_JSON, {}).oauthAccount;
  if (!existsSync(join(dir, '.claude.json')) && oauthAccount) writeJson(join(dir, '.claude.json'), { oauthAccount });
  if (!writeItem(serviceFor(dir), raw)) return 'could not write the store';
  return { name, orgId, orgName, dir };
}

// When each seat's login ends for good (the refresh token's own expiry): the live one for the active seat.
export function expiries(accounts: Account[], active: string | undefined): Record<string, number> {
  return Object.fromEntries(accounts.map(a => {
    const l = a.name === active ? liveLogin() : storeLogin(a);
    return [a.name, l?.refreshTokenExpiresAt ?? 0];
  }));
}
