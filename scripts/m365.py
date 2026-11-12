#!/usr/bin/env python3
"""Read Lucas's Microsoft 365 mail, calendar and Teams chats via Graph, delegated, read-only (app "Orch Macbook", TIKI tenant).
Run with ~/.local/share/orch-m365/venv/bin/python scripts/m365.py <command>.
  login                 device code sign-in (prints the code; waits until Lucas signs in)
  me                    who is signed in
  calendar [days]       events from today for N days (default 1)
  mail [n] [query]      newest n messages (default 10), optional $search query
  mail [n] --since <d>  messages received since date d (YYYY-MM-DD or ISO time), all of them unless n is given
  read <message id>     one message with its full body as text
  chats [n] [--since d] newest n Teams chats (default 20) with their messages; needs Chat.Read (sign in with M365_CHAT=1)
  --json                calendar, mail, read and chats print JSON instead of text
  --box <address>       any command on a shared mailbox, e.g. --box loesungen@tiki-institut.com (Lösungen)
The token cache lives in ~/.local/share/orch-m365/cache.json (mode 600) and never leaves this Mac."""
import html, json, os, re, sys, datetime as dt
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import msal, requests

CLIENT = '1bb52e3f-209c-4d5f-89f8-dc8095c34432'
TENANT = '302b5895-5a1e-4209-a37f-aee8ac9cf8b7'
CHAT = ['Chat.Read']
# Chat.Read is not granted yet; asking for it at sign-in would break sign-in until it is.
SCOPES = ['User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Calendars.Read', 'Calendars.Read.Shared'] + (
    CHAT if os.environ.get('M365_CHAT') == '1' else [])
CACHE = os.path.expanduser('~/.local/share/orch-m365/cache.json')
G = 'https://graph.microsoft.com/v1.0'
TZ = 'Europe/Berlin'
ME = '/me'


def app():
    cache = msal.SerializableTokenCache()
    if os.path.exists(CACHE):
        cache.deserialize(open(CACHE).read())
    a = msal.PublicClientApplication(CLIENT, authority=f'https://login.microsoftonline.com/{TENANT}', token_cache=cache)
    return a, cache


def save(cache):
    # Written to a temp file and renamed, so two runs at once never leave a half-written cache.
    if cache.has_state_changed:
        os.makedirs(os.path.dirname(CACHE), exist_ok=True)
        tmp = f'{CACHE}.{os.getpid()}'
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(cache.serialize())
        os.replace(tmp, CACHE)


def not_granted(scopes):
    sys.exit('not granted: ' + ' '.join(scopes))


def token(scopes=SCOPES):
    a, cache = app()
    accts = a.get_accounts()
    r = a.acquire_token_silent(scopes, account=accts[0]) if accts else None
    if not r or 'access_token' not in r:
        if accts and scopes is not SCOPES:
            not_granted(scopes)
        sys.exit('not signed in: run login')
    save(cache)
    return r['access_token']


class GraphError(Exception):
    def __init__(self, status, text):
        super().__init__(f'{status}: {text[:300]}')
        self.status = status


def get(path, params=None, headers=None, all_pages=False, limit=None, scopes=SCOPES, until=None):
    # Follows @odata.nextLink while all_pages is set, until limit items are collected
    # or until(item) holds for a page's last item (lists ordered newest first stop at a cutoff).
    h = {'Authorization': f'Bearer {token(scopes)}', **(headers or {})}
    url, out = (path if path.startswith('https://') else G + path), None
    while url:
        r = requests.get(url, params=params, headers=h, timeout=30)
        if r.status_code >= 400:
            raise GraphError(r.status_code, r.text)
        j = r.json()
        page = j.get('value', [])
        if out is None:
            out = j
        else:
            out['value'] += page
        done = (not all_pages or (limit is not None and len(out.get('value', [])) >= limit)
                or bool(until and page and until(page[-1])))
        url, params = (None if done else j.get('@odata.nextLink')), None
    if limit is not None and 'value' in out:
        out['value'] = out['value'][:limit]
    return out


def ts(s):
    return dt.datetime.fromisoformat(s) if s else None


def parse_since(s):
    try:
        d = dt.datetime.fromisoformat(s)
    except ValueError:
        sys.exit(f'--since: not a date: {s}')
    if d.tzinfo is None:
        d = d.replace(tzinfo=ZoneInfo(TZ))
    return d.astimezone(dt.timezone.utc)


def zone(name):
    # Graph can answer with a Windows zone name ("W. Europe Standard Time") that zoneinfo does not know.
    try:
        return ZoneInfo(name or TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return dt.timezone.utc


def person(r):
    e = (r or {}).get('emailAddress') or {}
    return {'name': e.get('name'), 'email': (e.get('address') or '').lower() or None}


def local_time(t):
    # Graph returns calendar times in the Prefer timezone without an offset; attach it.
    d = dt.datetime.fromisoformat(t['dateTime'][:19])
    return d.replace(tzinfo=zone(t.get('timeZone'))).isoformat()


def event(e):
    return {
        'id': e['id'],
        'subject': e.get('subject'),
        'start': local_time(e['start']),
        'end': local_time(e['end']),
        'location': (e.get('location') or {}).get('displayName') or None,
        'online': bool(e.get('isOnlineMeeting')),
        'cancelled': bool(e.get('isCancelled')),
        'organizer': person(e.get('organizer')),
        'attendees': [{**person(a), 'type': a.get('type'), 'response': (a.get('status') or {}).get('response')}
                      for a in e.get('attendees', [])],
        'preview': e.get('bodyPreview') or '',
        'link': e.get('webLink'),
    }


def message(m):
    out = {
        'id': m['id'],
        'conversationId': m.get('conversationId'),
        'subject': m.get('subject'),
        'from': person(m.get('from')),
        'to': [person(r) for r in m.get('toRecipients', [])],
        'cc': [person(r) for r in m.get('ccRecipients', [])],
        'received': m.get('receivedDateTime'),
        'sent': m.get('sentDateTime'),
        'link': m.get('webLink'),
    }
    if 'body' in m:
        out['body'] = m['body'].get('content', '')
    else:
        out['preview'] = m.get('bodyPreview') or ''
    return out


def text_of(body):
    s = (body or {}).get('content') or ''
    if (body or {}).get('contentType') == 'html':
        s = re.sub(r'<br\s*/?>|</p>|</div>', '\n', s, flags=re.I)
        s = html.unescape(re.sub(r'<[^>]+>', '', s))
    return s.strip()


def chat_time(c):
    # lastUpdatedDateTime moves on renames and member changes, not on messages; the last message's time is the activity.
    return (c.get('lastMessagePreview') or {}).get('createdDateTime') or c.get('lastUpdatedDateTime')


def chat(c, msgs):
    members = [{'name': m.get('displayName'), 'email': (m.get('email') or '').lower() or None, 'userId': m.get('userId')}
               for m in c.get('members', [])]
    email = {m['userId']: m['email'] for m in members if m['userId']}
    out = []
    for m in msgs:
        if m.get('messageType') != 'message' or m.get('deletedDateTime'):
            continue
        u = (m.get('from') or {}).get('user') or {}
        out.append({'id': m['id'], 'created': m.get('createdDateTime'),
                    'from': {'name': u.get('displayName'), 'email': email.get(u.get('id'))},
                    'text': text_of(m.get('body'))})
    return {'id': c['id'], 'topic': c.get('topic'), 'type': c.get('chatType'),
            'updated': chat_time(c), 'link': c.get('webUrl'), 'members': members, 'messages': out}


def dump(x):
    print(json.dumps(x, ensure_ascii=False, indent=1))


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
    srv.timeout = 30
    import time
    deadline = time.time() + 900
    while not got and time.time() < deadline:
        srv.handle_request()
    if not got:
        sys.exit('no sign-in within 15 minutes')
    r = a.acquire_token_by_auth_code_flow(flow, got)
    save(cache)
    print('signed in as', r.get('id_token_claims', {}).get('preferred_username') if 'access_token' in r else r)


def flag(argv, name, has_value=True):
    if name not in argv:
        return argv, None
    i = argv.index(name)
    if not has_value:
        return argv[:i] + argv[i + 1:], True
    if i + 1 >= len(argv):
        sys.exit(f'usage: {name} <value>')
    return argv[:i] + argv[i + 2:], argv[i + 1]


JSON_CMDS, SINCE_CMDS = ('calendar', 'mail', 'read', 'chats'), ('mail', 'chats')


def main(argv):
    try:
        return command(argv)
    except GraphError as e:
        sys.exit(str(e))


def command(argv):
    # --box <address>: a shared mailbox Lucas can open (e.g. loesungen@tiki-institut.com) instead of his own.
    global ME
    ME = '/me'
    argv, box = flag(argv, '--box')
    argv, as_json = flag(argv, '--json', has_value=False)
    argv, since = flag(argv, '--since')
    if box:
        from urllib.parse import quote as q
        ME = '/users/' + q(box, safe='@')
    cmd = argv[0] if argv else 'me'
    if as_json and cmd not in JSON_CMDS:
        sys.exit(f'--json: not supported by {cmd} (only {", ".join(JSON_CMDS)})')
    if since and cmd not in SINCE_CMDS:
        sys.exit(f'--since: not supported by {cmd} (only {", ".join(SINCE_CMDS)})')
    since = since and parse_since(since)
    fresh = lambda s: since is None or (s is not None and ts(s) >= since)
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
        ev = get(f'{ME}/calendarView', {'startDateTime': start.isoformat(), 'endDateTime': end.isoformat(),
                                       '$orderby': 'start/dateTime', '$top': 100,
                                       '$select': 'id,subject,start,end,location,organizer,attendees,isOnlineMeeting,'
                                                  'isCancelled,bodyPreview,webLink'},
                 {'Prefer': f'outlook.timezone="{TZ}"'}, all_pages=True)
        if as_json:
            return dump([event(e) for e in ev.get('value', [])])
        for e in ev.get('value', []):
            who = ', '.join(a['emailAddress']['name'] for a in e.get('attendees', [])[:6])
            print(f"{e['start']['dateTime'][:16]}–{e['end']['dateTime'][11:16]}  {e['subject']}  [{who}]")
        return
    if cmd == 'mail':
        n = int(argv[1]) if len(argv) > 1 else (None if since else 10)
        q = ' '.join(argv[2:])
        if q and since:
            sys.exit('mail: a search query and --since do not combine (Graph has no $filter with $search on messages)')
        p = {'$top': min(n or 100, 100), '$select': 'id,conversationId,subject,from,toRecipients,ccRecipients,'
                                                    'receivedDateTime,sentDateTime,bodyPreview,webLink'}
        if q:
            p['$search'] = '"' + q.replace('"', ' ') + '"'
        else:
            p['$orderby'] = 'receivedDateTime desc'
        if since:
            p['$filter'] = f"receivedDateTime ge {since.strftime('%Y-%m-%dT%H:%M:%SZ')}"
        ms = get(f'{ME}/messages', p, {'ConsistencyLevel': 'eventual'} if q else None, all_pages=True, limit=n).get('value', [])
        if as_json:
            return dump([message(m) for m in ms])
        for m in ms:
            f = (m.get('from') or {}).get('emailAddress', {}).get('name', '?')
            print(f"{m['receivedDateTime'][:16]}  {f}: {m['subject']}\n  id {m['id']}")
        return
    if cmd == 'read':
        if len(argv) < 2:
            sys.exit('usage: read <message id>')
        from urllib.parse import quote
        m = get(f'{ME}/messages/{quote(argv[1], safe="")}',
                {'$select': 'id,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,webLink'},
                {'Prefer': 'outlook.body-content-type="text"'})
        if as_json:
            return dump(message(m))
        print(m['subject'], '\n', m['receivedDateTime'], (m.get('from') or {}).get('emailAddress'), '\n')
        return print(m['body']['content'])
    if cmd == 'chats':
        n = int(argv[1]) if len(argv) > 1 else (None if since else 20)
        # Newest activity first, so paging stops at the first chat older than --since.
        try:
            cs = get('/me/chats', {'$expand': 'members,lastMessagePreview', '$top': min(n or 50, 50),
                                   '$orderby': 'lastMessagePreview/createdDateTime desc'},
                     all_pages=True, limit=n, scopes=CHAT,
                     until=since and (lambda c: not fresh(chat_time(c)))).get('value', [])
        except GraphError as e:
            if e.status == 403:
                not_granted(CHAT)
            raise
        out = []
        for c in (c for c in cs if fresh(chat_time(c))):
            # Graph has no createdDateTime gt filter on chat messages: page newest first and cut locally.
            try:
                if len(c.get('members', [])) >= 25:  # $expand=members stops at 25
                    c['members'] = get(f"/chats/{c['id']}/members", all_pages=True, scopes=CHAT)['value']
                msgs = get(f"/chats/{c['id']}/messages", {'$top': 50, '$orderby': 'createdDateTime desc'},
                           all_pages=bool(since), scopes=CHAT,
                           until=since and (lambda m: not fresh(m.get('createdDateTime')))).get('value', [])
            except GraphError as e:
                print(f"skipped chat {c['id']}: {e}", file=sys.stderr)
                continue
            out.append(chat(c, [m for m in msgs if fresh(m.get('createdDateTime'))]))
        if as_json:
            return dump(out)
        for c in out:
            names = c['topic'] or ', '.join(m['name'] or '?' for m in c['members'])
            print(f"{(c['updated'] or '')[:16]}  {names}  ({c['type']})")
            for m in c['messages']:
                print(f"  {m['created'][:16]}  {m['from']['name'] or '?'}: {' '.join(m['text'].split())[:200]}")
        return
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
