// Switching Claude logins between organizations when one runs out (accounts/README.md). Pure: what the usage numbers
// mean, when to switch, which lines to say. src/accounts-io.ts does the keychain, the usage endpoint and the logins.
//
// One person can hold a seat in several organizations; each seat has its own 5-hour and weekly limit. All sessions on
// this Mac share one login (the keychain item "Claude Code-credentials") and re-read it every 30 s, so swapping that
// item moves every running session to the other seat without a restart (tested 2026-11-25).

export type Window = { pct: number; resetsAt: number }; // used %, reset time in ms
export type Usage = { fiveHour: Window; sevenDay: Window; at: number }; // at: when orch read it
export type Account = { name: string; orgId: string; orgName: string; dir: string };
export type AccountsState = {
  usage: Record<string, Usage>;
  lastSwitch: number;
  fullSaid: number;
  loginSaid: Record<string, string>; // name -> day the login-due line was last said
  errorSaid: Record<string, number>; // error text -> when said
};
export const EMPTY: AccountsState = { usage: {}, lastSwitch: 0, fullSaid: 0, loginSaid: {}, errorSaid: {} };

export const SWITCH_AT = 95; // switch when the active seat passes this on either window
export const ROOM_BELOW = 90; // the target seat must be under this on both windows
export const GAP_MS = 30 * 60_000; // never two switches within this
export const RESET_SOON_MS = 15 * 60_000; // a full window that resets this soon is waited out instead
export const ACTIVE_POLL_MS = 3 * 60_000;
export const STANDBY_POLL_MS = 15 * 60_000;
export const STALE_MS = 10 * 60_000; // active numbers older than this are not acted on
export const FULL_REPEAT_MS = 60 * 60_000;
export const ERROR_REPEAT_MS = 60 * 60_000;
export const LOGIN_WARN_DAYS = 5;

// The usage endpoint (GET /api/oauth/usage, the numbers /usage shows): utilization 0-100, resets_at ISO.
export function parseUsage(body: any, now: number): Usage | undefined {
  const w = (x: any): Window | undefined => {
    if (!x || typeof x.utilization !== 'number') return undefined;
    const r = Date.parse(x.resets_at ?? '');
    return { pct: x.utilization, resetsAt: Number.isFinite(r) ? r : 0 };
  };
  const fiveHour = w(body?.five_hour), sevenDay = w(body?.seven_day);
  return fiveHour && sevenDay ? { fiveHour, sevenDay, at: now } : undefined;
}

// A window whose reset time has passed is empty, whatever orch last read.
export const pctNow = (w: Window, now: number) => (w.resetsAt && w.resetsAt <= now ? 0 : w.pct);
const peak = (u: Usage, now: number) => Math.max(pctNow(u.fiveHour, now), pctNow(u.sevenDay, now));
const windows = (u: Usage) => [['5h', u.fiveHour], ['week', u.sevenDay]] as const;

export const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
export const when = (ms: number, now: number) =>
  ms - now < 20 * 3600_000 ? hhmm(ms) : new Date(ms).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
export const describe = (u: Usage, now: number) =>
  windows(u).map(([k, w]) => `${k} ${Math.round(pctNow(w, now))}%`).join(', ');

export type Verdict =
  | { kind: 'stay' }
  | { kind: 'switch'; to: string; line: string }
  | { kind: 'full'; line: string };

// Whether to move off the active seat now. The active seat's numbers must be fresh; the others' may be old, a window
// that has reset since counts as empty. The best target is the one with the most room.
export function decide(accounts: Account[], active: string, s: AccountsState, now: number): Verdict {
  const u = s.usage[active];
  if (!u || now - u.at > STALE_MS) return { kind: 'stay' };
  const hot = windows(u).filter(([, w]) => pctNow(w, now) >= SWITCH_AT);
  if (!hot.length) return { kind: 'stay' };
  // Every full window resets within minutes: waiting is cheaper than a switch.
  if (hot.every(([, w]) => w.resetsAt - now <= RESET_SOON_MS)) return { kind: 'stay' };
  if (now - s.lastSwitch < GAP_MS) return { kind: 'stay' };
  const targets = accounts
    .filter(a => a.name !== active && s.usage[a.name])
    .map(a => ({ a, u: s.usage[a.name] }))
    .filter(t => peak(t.u, now) < ROOM_BELOW)
    .sort((x, y) => peak(x.u, now) - peak(y.u, now));
  if (targets[0]) {
    const t = targets[0];
    return { kind: 'switch', to: t.a.name, line: `ACCOUNT switched ${active} -> ${t.a.name} (${active}: ${describe(u, now)}; ${t.a.name}: ${describe(t.u, now)})` };
  }
  if (now - s.fullSaid < FULL_REPEAT_MS) return { kind: 'stay' };
  const others = accounts.filter(a => a.name !== active);
  const room = [u, ...others.map(a => s.usage[a.name]).filter(Boolean)]
    .map(x => Math.max(...windows(x).filter(([, w]) => pctNow(w, now) >= ROOM_BELOW).map(([, w]) => w.resetsAt), 0))
    .filter(t => t > now);
  const earliest = room.length ? ` Earliest room: ${when(Math.min(...room), now)}.` : '';
  const rest = others.map(a => s.usage[a.name] ? `${a.name}: ${describe(s.usage[a.name], now)}` : `${a.name}: no numbers yet`).join('; ');
  return { kind: 'full', line: `ACCOUNT full: ${active}: ${describe(u, now)}; ${rest}.${earliest}` };
}

// Which seats to poll now: the active one every 3 minutes, the others every 15.
export const pollDue = (name: string, active: string, s: AccountsState, now: number) =>
  now - (s.usage[name]?.at ?? 0) >= (name === active ? ACTIVE_POLL_MS : STANDBY_POLL_MS);

// A login lives about 30 days and cannot be renewed past that; orch asks for a fresh one 5 days ahead, once a day.
export function loginLines(expiries: Record<string, number>, s: AccountsState, now: number, today: string): { lines: string[]; said: Record<string, string> } {
  const lines: string[] = [], said = { ...s.loginSaid };
  for (const [name, exp] of Object.entries(expiries)) {
    if (!exp || exp - now > LOGIN_WARN_DAYS * 864e5 || said[name] === today) continue;
    const date = new Date(exp).toLocaleDateString('sv-SE');
    lines.push(exp <= now
      ? `ACCOUNT login expired ${name} (${date}): run orch account login ${name}`
      : `ACCOUNT login due ${name}: expires ${date}, run orch account login ${name}`);
    said[name] = today;
  }
  return { lines, said };
}

// An error line at most once an hour per text, so a broken keychain or endpoint does not flood orch.
export function errorLine(text: string, s: AccountsState, now: number): { line?: string; said: Record<string, number> } {
  const said = Object.fromEntries(Object.entries(s.errorSaid).filter(([, t]) => now - t < ERROR_REPEAT_MS));
  if (said[text]) return { said };
  return { line: `ACCOUNT error: ${text}`, said: { ...said, [text]: now } };
}

// The table orch account status prints, and the brief's section.
export function statusLines(accounts: Account[], active: string | undefined, s: AccountsState, expiries: Record<string, number>, now: number): string[] {
  return accounts.map(a => {
    const u = s.usage[a.name];
    const nums = u
      ? windows(u).map(([k, w]) => `${k} ${String(Math.round(pctNow(w, now))).padStart(3)}% (resets ${when(w.resetsAt, now)})`).join('  ')
      : 'no numbers yet';
    const age = u ? `, read ${Math.round((now - u.at) / 60_000)} min ago` : '';
    const exp = expiries[a.name] ? `, login until ${new Date(expiries[a.name]).toLocaleDateString('sv-SE')}` : '';
    return `${a.name === active ? '*' : ' '} ${a.name.padEnd(14)} ${nums}${age}${exp}`;
  });
}

// Keychain service of a config dir's login, as Claude Code names it: the live login has none, CLAUDE_CONFIG_DIR=<dir>
// adds the first 8 hex of sha256(dir).
export const LIVE_SERVICE = 'Claude Code-credentials';
export const serviceSuffix = (sha256hex: string) => `${LIVE_SERVICE}-${sha256hex.slice(0, 8)}`;

// The stored login JSON ({ claudeAiOauth: {...} }).
export type Login = { accessToken: string; expiresAt: number; refreshTokenExpiresAt?: number; organizationUuid?: string };
export function parseLogin(raw: string | undefined): Login | undefined {
  try {
    const o = JSON.parse(raw ?? '')?.claudeAiOauth;
    return o?.accessToken ? o : undefined;
  } catch { return undefined; }
}

// The login URL claude auth login prints, from a pane's unwrapped output.
export const loginUrl = (out: string) => out.match(/https:\/\/claude\.ai\/oauth\/authorize\S+/g)?.at(-1);
