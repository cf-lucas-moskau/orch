// orch account: see and switch the Claude seats (accounts/README.md).
//   status                 both seats' 5h and weekly numbers, resets, login expiry; reads them fresh
//   adopt <name>           give the seat that is live now a store, under <name>
//   login <name>           start a login for <name>; prints the link to open in your browser
//   code <name> <code>     finish it with the code the browser shows; a new seat joins accounts/config.json
//   use <name>             switch now (the watcher does this by itself at 95%)
import { decide, statusLines } from './accounts.ts';
import { activeName, adoptLive, authStatus, expiries, finishLogin, liveLogin, loadAccounts, loadState, readItem, readUsage, saveAccounts, saveState, serviceFor, startLogin, swap, writeItem } from './accounts-io.ts';
import { LIVE_SERVICE } from './accounts.ts';

export async function account(root: string, args: string[], log: (m: string) => void, die: (m: string) => never) {
  const [sub, name, code] = args;
  const accounts = loadAccounts(root);
  const find = (n?: string) => accounts.find(a => a.name === n) ?? die(`no seat ${n}; seats: ${accounts.map(a => a.name).join(', ') || 'none (orch account adopt <name>)'}`);

  if (!sub || sub === 'status') {
    const active = activeName(accounts);
    const s = loadState(root), now = Date.now();
    for (const a of accounts) {
      const r = await readUsage(a, active);
      if (r.usage) s.usage[a.name] = r.usage;
      else if (r.error) console.log(`(${r.error})`);
    }
    saveState(root, s);
    if (!accounts.length) return console.log('No seats yet. orch account adopt <name> for the live one, orch account login <name> for another.');
    console.log(statusLines(accounts, active, s, expiries(accounts, active), now).join('\n'));
    if (!active) console.log(`The live login is none of these seats (org ${liveLogin()?.organizationUuid ?? 'none'}).`);
    const v = active ? decide(accounts, active, { ...s, lastSwitch: 0, fullSaid: 0 }, now) : undefined;
    if (v && v.kind !== 'stay') console.log(`\nThe watcher would act now: ${v.line}`);
    return;
  }

  if (sub === 'adopt') {
    if (!name) die('orch account adopt <name>');
    if (accounts.some(a => a.name === name)) die(`${name} is already a seat`);
    const st = await authStatus();
    if (!st?.orgId) die('no live login');
    const r = adoptLive(name, st.orgId!, st.orgName ?? name);
    if (typeof r === 'string') die(r);
    saveAccounts(root, [...accounts.filter(a => a.orgId !== st.orgId), r]);
    log(`account adopt ${name}: ${r.orgName} (${r.orgId}) is a seat, store ${r.dir}`);
    return console.log(`${name}: ${r.orgName} is a seat now.`);
  }

  if (sub === 'login') {
    if (!name) die('orch account login <name>');
    const r = await startLogin(root, name);
    if (r.error) die(r.error);
    log(`account login ${name}: link issued`);
    return console.log(`Open this link in your normal browser, pick the organization for ${name}, click Authorize, then send orch the code:\n${r.url}\n\nFinish with: npm run -s orch -- account code ${name} <code>`);
  }

  if (sub === 'code') {
    if (!name || !code) die('orch account code <name> <code>');
    const r = await finishLogin(root, name, code);
    if (!r.account) die(r.error ?? 'login failed');
    const a = r.account!;
    const clash = accounts.find(x => x.orgId === a.orgId && x.name !== name);
    if (clash) die(`that login is ${a.orgName}, which is seat ${clash.name} already; log in again and pick the other organization`);
    const known = accounts.find(x => x.name === name);
    if (known && known.orgId !== a.orgId) die(`${name} is ${known.orgName}, but the login is ${a.orgName}; log in again and pick ${known.orgName}`);
    saveAccounts(root, [...accounts.filter(x => x.name !== name), a]);
    // The active seat's fresh login replaces the live one too: the old live login ends on its own date.
    if (activeName(accounts) === name) {
      const raw = readItem(serviceFor(a.dir));
      if (!raw || !writeItem(process.env.ORCH_LIVE_SERVICE ?? LIVE_SERVICE, raw)) die('logged in, but could not copy the fresh login to the live one');
    }
    log(`account code ${name}: logged in to ${a.orgName}`);
    return console.log(`${name}: logged in to ${a.orgName}.`);
  }

  if (sub === 'use') {
    const to = find(name);
    const active = activeName(accounts);
    if (active === to.name) return console.log(`${to.name} is live already.`);
    const from = find(active);
    const err = await swap(from, to);
    if (err) die(err);
    const s = loadState(root);
    saveState(root, { ...s, lastSwitch: Date.now() });
    log(`account use ${to.name}: switched ${from.name} -> ${to.name} by hand`);
    return console.log(`Switched ${from.name} -> ${to.name}. Running sessions pick it up within 30 seconds.`);
  }

  die('orch account status | adopt <name> | login <name> | code <name> <code> | use <name>');
}
