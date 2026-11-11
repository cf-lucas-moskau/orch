#!/usr/bin/env python3
"""Read Lucas's Microsoft 365 mail and calendar via Graph, delegated, read-only (app "Orch Macbook", TIKI tenant).
Run with ~/.local/share/orch-m365/venv/bin/python scripts/m365.py <command>.
  login                 device code sign-in (prints the code; waits until Lucas signs in)
  me                    who is signed in
  calendar [days]       events from today for N days (default 1)
  mail [n] [query]      newest n messages (default 10), optional $search query
  read <message id>     one message as text
The token cache lives in ~/.local/share/orch-m365/cache.json (mode 600) and never leaves this Mac."""
import json, os, sys, datetime as dt
import msal, requests

CLIENT = '1bb52e3f-209c-4d5f-89f8-dc8095c34432'
TENANT = '302b5895-5a1e-4209-a37f-aee8ac9cf8b7'
SCOPES = ['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Calendars.Read', 'Calendars.Read.Shared']
CACHE = os.path.expanduser('~/.local/share/orch-m365/cache.json')
G = 'https://graph.microsoft.com/v1.0'


def app():
    cache = msal.SerializableTokenCache()
    if os.path.exists(CACHE):
        cache.deserialize(open(CACHE).read())
    a = msal.PublicClientApplication(CLIENT, authority=f'https://login.microsoftonline.com/{TENANT}', token_cache=cache)
    return a, cache


def save(cache):
    if cache.has_state_changed:
        fd = os.open(CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(cache.serialize())


def token():
    a, cache = app()
    accts = a.get_accounts()
    r = a.acquire_token_silent(SCOPES, account=accts[0]) if accts else None
    if not r or 'access_token' not in r:
        sys.exit('not signed in: run login')
    save(cache)
    return r['access_token']


def get(path, params=None, headers=None):
    h = {'Authorization': f'Bearer {token()}', **(headers or {})}
    r = requests.get(G + path, params=params, headers=h, timeout=30)
    if r.status_code >= 400:
        sys.exit(f'{r.status_code}: {r.text[:300]}')
    return r.json()


def login():
    a, cache = app()
    flow = a.initiate_device_flow(scopes=SCOPES)
    if 'user_code' not in flow:
        sys.exit(json.dumps(flow, indent=1))
    print(flow['message'], flush=True)
    r = a.acquire_token_by_device_flow(flow)
    save(cache)
    print('signed in as', r.get('id_token_claims', {}).get('preferred_username') if 'access_token' in r else r)


def login_web(port=8400):
    # Browser sign-in (auth code + PKCE) for tenants that block device code: the sign-in URL opens in Lucas's browser
    # on his compliant work Mac, and the redirect to http://localhost:<port> reaches this Mac through an SSH tunnel.
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from urllib.parse import urlparse, parse_qs
    a, cache = app()
    flow = a.initiate_auth_code_flow(SCOPES, redirect_uri=f'http://localhost:{port}')
    print('Open this in your browser:\n' + flow['auth_uri'], flush=True)
    got = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            q = parse_qs(urlparse(self.path).query)
            if 'code' not in q and 'error' not in q:
                self.send_response(404); self.end_headers(); return
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header('Content-Type', 'text/plain; charset=utf-8'); self.end_headers()
            self.wfile.write('Angemeldet. Du kannst dieses Fenster schliessen.'.encode())

        def log_message(self, *a):
            pass

    srv = HTTPServer(('127.0.0.1', port), H)
    srv.timeout = 900
    while not got:
        srv.handle_request()
    r = a.acquire_token_by_auth_code_flow(flow, got)
    save(cache)
    print('signed in as', r.get('id_token_claims', {}).get('preferred_username') if 'access_token' in r else r)


def main(argv):
    cmd = argv[0] if argv else 'me'
    if cmd == 'login':
        return login()
    if cmd == 'login-web':
        return login_web(int(argv[1]) if len(argv) > 1 else 8400)
    if cmd == 'me':
        m = get('/me')
        return print(m.get('displayName'), m.get('userPrincipalName'))
    if cmd == 'calendar':
        days = int(argv[1]) if len(argv) > 1 else 1
        start = dt.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + dt.timedelta(days=days)
        ev = get('/me/calendarView', {'startDateTime': start.isoformat(), 'endDateTime': end.isoformat(),
                                       '$orderby': 'start/dateTime', '$top': 100,
                                       '$select': 'subject,start,end,location,organizer,attendees,isOnlineMeeting'},
                 {'Prefer': 'outlook.timezone="Europe/Berlin"'})
        for e in ev.get('value', []):
            who = ', '.join(a['emailAddress']['name'] for a in e.get('attendees', [])[:6])
            print(f"{e['start']['dateTime'][:16]}–{e['end']['dateTime'][11:16]}  {e['subject']}  [{who}]")
        return
    if cmd == 'mail':
        n = int(argv[1]) if len(argv) > 1 else 10
        q = ' '.join(argv[2:])
        p = {'$top': n, '$select': 'id,subject,from,receivedDateTime,bodyPreview'}
        if q:
            p['$search'] = f'"{q}"'
        else:
            p['$orderby'] = 'receivedDateTime desc'
        for m in get('/me/messages', p, {'ConsistencyLevel': 'eventual'} if q else None).get('value', []):
            f = (m.get('from') or {}).get('emailAddress', {}).get('name', '?')
            print(f"{m['receivedDateTime'][:16]}  {f}: {m['subject']}\n  id {m['id']}")
        return
    if cmd == 'read':
        m = get(f'/me/messages/{argv[1]}', {'$select': 'subject,from,toRecipients,receivedDateTime,body'},
                {'Prefer': 'outlook.body-content-type="text"'})
        print(m['subject'], '\n', m['receivedDateTime'], (m.get('from') or {}).get('emailAddress'), '\n')
        return print(m['body']['content'])
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
