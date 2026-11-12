"""scripts/m365.py against hand-recorded Graph responses in test/fixtures/m365; msal and requests are stubbed, nothing touches the network."""
import contextlib, importlib.util, io, json, os, sys, types, unittest

sys.dont_write_bytecode = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIX = os.path.join(ROOT, 'test', 'fixtures', 'm365')
G = 'https://graph.microsoft.com/v1.0'


def fixture(name):
    with open(os.path.join(FIX, name)) as f:
        return json.load(f)


class Resp:
    def __init__(self, status, body):
        self.status_code, self._body, self.text = status, body, json.dumps(body)

    def json(self):
        return self._body


class Fake:
    """Graph and msal stand-ins: routes maps a URL to (status, fixture name or body); calls records every request."""
    granted = {'User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Calendars.Read', 'Calendars.Read.Shared'}
    accounts = [{'username': 'lucas@tiki.example'}]

    def __init__(self):
        self.routes, self.calls = {}, []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, dict(params or {}), dict(headers or {})))
        status, body = self.routes[url]
        return Resp(status, fixture(body) if isinstance(body, str) else body or {'error': {'code': 'Forbidden'}})


fake = Fake()


class Cache:
    has_state_changed = False

    def deserialize(self, s):
        pass


class App:
    def __init__(self, *a, **k):
        pass

    def get_accounts(self):
        return fake.accounts

    def acquire_token_silent(self, scopes, account):
        if set(scopes) <= fake.granted:
            return {'access_token': 'SECRET-TOKEN', 'scope': ' '.join(scopes)}
        return {'error': 'invalid_grant', 'suberror': 'consent_required'}


sys.modules['msal'] = types.SimpleNamespace(SerializableTokenCache=Cache, PublicClientApplication=App)
sys.modules['requests'] = types.SimpleNamespace(get=fake.get)


def load(env=None):
    old = dict(os.environ)
    os.environ.update(env or {})
    try:
        spec = importlib.util.spec_from_file_location('m365', os.path.join(ROOT, 'scripts', 'm365.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        os.environ.clear()
        os.environ.update(old)
    mod.CACHE = os.path.join(FIX, 'no-such-cache.json')
    return mod


m365 = load()


def run(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        m365.main(list(argv))
    return out.getvalue()


class M365(unittest.TestCase):
    def setUp(self):
        fake.routes, fake.calls = {}, []
        fake.granted = set(Fake.granted)
        fake.accounts = Fake.accounts

    def test_calendar_text_is_unchanged_and_pages(self):
        fake.routes = {G + '/me/calendarView': (200, 'calendar.json'),
                       G + '/me/calendarView?$skip=1': (200, 'calendar-2.json')}
        self.assertEqual(run('calendar'),
                         '2026-11-12T09:00–09:30  Netto Abstimmung  [Lucas Moskau, Max Beispiel]\n'
                         '2026-11-12T14:00–15:00  Jour fixe  []\n')

    def test_calendar_json_has_addresses_and_offsets(self):
        fake.routes = {G + '/me/calendarView': (200, 'calendar.json'),
                       G + '/me/calendarView?$skip=1': (200, 'calendar-2.json')}
        got = json.loads(run('calendar', '--json'))
        self.assertEqual(got[0], {
            'id': 'AAMkEV1', 'subject': 'Netto Abstimmung',
            'start': '2026-11-12T09:00:00+01:00', 'end': '2026-11-12T09:30:00+01:00',
            'location': 'Microsoft Teams-Besprechung', 'online': True, 'cancelled': False,
            'organizer': {'name': 'Erika Muster', 'email': 'erika.muster@netto.example'},
            'attendees': [
                {'name': 'Lucas Moskau', 'email': 'lucas@tiki.example', 'type': 'required', 'response': 'accepted'},
                {'name': 'Max Beispiel', 'email': 'max@netto.example', 'type': 'optional', 'response': 'none'}],
            'preview': 'Agenda: Angebot Q1', 'link': 'https://outlook.office365.com/owa/?itemid=AAMkEV1'})
        self.assertEqual([(e['id'], e['start'], e['location'], e['cancelled'], e['attendees']) for e in got[1:]],
                         [('AAMkEV2', '2026-11-12T14:00:00+01:00', None, True, [])])

    def test_mail_text_is_unchanged_one_page(self):
        fake.routes = {G + '/me/messages': (200, 'messages.json')}
        self.assertEqual(run('mail', '1'),
                         '2026-11-11T08:15  Erika Muster: Angebot KI-Schulung\n  id AAMkMSG1\n')
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0][1]['$top'], 1)
        self.assertEqual(fake.calls[0][1]['$orderby'], 'receivedDateTime desc')

    def test_mail_search_sends_search_header(self):
        fake.routes = {G + '/me/messages': (200, 'messages.json')}
        run('mail', '1', 'KI', 'Schulung')
        url, params, headers = fake.calls[0]
        self.assertEqual(params['$search'], '"KI Schulung"')
        self.assertNotIn('$orderby', params)
        self.assertEqual(headers['ConsistencyLevel'], 'eventual')

    def test_mail_since_pages_and_filters_json(self):
        fake.routes = {G + '/me/messages': (200, 'messages.json'),
                       G + '/me/messages?$skip=1': (200, 'messages-2.json')}
        got = json.loads(run('mail', '--since', '2026-11-01T00:00:00Z', '--json'))
        self.assertEqual(fake.calls[0][1]['$filter'], 'receivedDateTime ge 2026-11-01T00:00:00Z')
        self.assertEqual(fake.calls[1][1], {}, 'nextLink carries its own query')
        self.assertEqual([m['id'] for m in got], ['AAMkMSG1', 'AAMkMSG2'])
        self.assertEqual(got[0], {
            'id': 'AAMkMSG1', 'conversationId': 'AAQkCONV1', 'subject': 'Angebot KI-Schulung',
            'from': {'name': 'Erika Muster', 'email': 'erika.muster@netto.example'},
            'to': [{'name': 'Lucas Moskau', 'email': 'lucas@tiki.example'}],
            'cc': [{'name': 'Max Beispiel', 'email': 'max@netto.example'}],
            'received': '2026-11-11T08:15:00Z', 'sent': '2026-11-11T08:14:58Z',
            'link': 'https://outlook.office365.com/owa/?ItemID=AAMkMSG1', 'preview': 'Hallo Lucas, anbei unser Feedback'})

    def test_mail_since_date_is_berlin_midnight(self):
        fake.routes = {G + '/me/messages': (200, 'messages-2.json')}
        run('mail', '--since', '2026-11-01')
        self.assertEqual(fake.calls[0][1]['$filter'], 'receivedDateTime ge 2026-10-31T23:00:00Z')

    def test_mail_since_stops_at_n(self):
        fake.routes = {G + '/me/messages': (200, 'messages.json')}
        got = json.loads(run('mail', '1', '--since', '2026-11-01', '--json'))
        self.assertEqual([m['id'] for m in got], ['AAMkMSG1'])
        self.assertEqual(len(fake.calls), 1)

    def test_mail_since_rejects_bad_date_and_search(self):
        with self.assertRaises(SystemExit) as e:
            run('mail', '--since', 'gestern')
        self.assertEqual(e.exception.code, '--since: not a date: gestern')
        with self.assertRaises(SystemExit):
            run('mail', '5', 'netto', '--since', '2026-11-01')
        self.assertEqual(fake.calls, [])

    def test_read_text_and_json_carry_full_body(self):
        fake.routes = {G + '/me/messages/AAMkMSG1': (200, 'message.json')}
        body = 'Hallo Lucas,\r\n\r\nanbei unser Feedback zum Angebot.\r\n\r\nViele Grüße\r\nErika'
        self.assertEqual(run('read', 'AAMkMSG1'),
                         "Angebot KI-Schulung \n 2026-11-11T08:15:00Z {'name': 'Erika Muster', 'address': "
                         "'Erika.Muster@netto.example'} \n\n" + body + '\n')
        got = json.loads(run('read', 'AAMkMSG1', '--json'))
        self.assertEqual(got['body'], body)
        self.assertEqual(got['from'], {'name': 'Erika Muster', 'email': 'erika.muster@netto.example'})
        self.assertNotIn('preview', got)
        self.assertEqual(fake.calls[0][2]['Prefer'], 'outlook.body-content-type="text"')

    def test_box_reads_the_shared_mailbox(self):
        fake.routes = {G + '/users/loesungen@tiki.example/messages': (200, 'messages-2.json')}
        got = json.loads(run('--box', 'loesungen@tiki.example', 'mail', '--json'))
        self.assertEqual(got[0]['to'], [{'name': 'Hans Zoll', 'email': 'hans@zollner.example'}])

    def test_chats_not_granted_exits_cleanly_without_calling_graph(self):
        with self.assertRaises(SystemExit) as e:
            run('chats')
        self.assertEqual(e.exception.code, 'not granted: Chat.Read')
        self.assertEqual(fake.calls, [])

    def test_chats_forbidden_by_graph_is_not_granted(self):
        fake.granted.add('Chat.Read')
        fake.routes = {G + '/me/chats': (403, None)}
        with self.assertRaises(SystemExit) as e:
            run('chats')
        self.assertEqual(e.exception.code, 'not granted: Chat.Read')

    def test_not_signed_in(self):
        fake.accounts = []
        with self.assertRaises(SystemExit) as e:
            run('chats')
        self.assertEqual(e.exception.code, 'not signed in: run login')

    def chat_routes(self):
        fake.granted.add('Chat.Read')
        fake.routes = {G + '/me/chats': (200, 'chats.json'),
                       G + '/chats/19:abc@thread.v2/messages': (200, 'chat-messages.json'),
                       G + '/chats/19:revived@thread.v2/messages': (200, 'chat-messages-revived.json')}

    def test_chats_json_since_cuts_on_message_activity(self):
        self.chat_routes()
        got = json.loads(run('chats', '--since', '2026-11-01', '--json'))
        self.assertEqual([u for u, _, _ in fake.calls], [
            G + '/me/chats', G + '/chats/19:abc@thread.v2/messages', G + '/chats/19:revived@thread.v2/messages'],
            'no second page of chats or messages: both stop at the first item older than --since')
        self.assertEqual(fake.calls[0][1]['$expand'], 'members,lastMessagePreview')
        self.assertEqual(fake.calls[0][1]['$orderby'], 'lastMessagePreview/createdDateTime desc')
        self.assertEqual(fake.calls[1][1], {'$top': 50, '$orderby': 'createdDateTime desc'})
        self.assertEqual(got[0], {
            'id': '19:abc@thread.v2', 'topic': None, 'type': 'oneOnOne', 'updated': '2026-11-11T10:00:00.000Z',
            'link': 'https://teams.microsoft.com/l/chat/19%3Aabc%40thread.v2/0',
            'members': [{'name': 'Lucas Moskau', 'email': 'lucas@tiki.example', 'userId': 'u-lucas'},
                        {'name': 'Erika Muster', 'email': 'erika.muster@netto.example', 'userId': 'u-erika'}],
            'messages': [
                {'id': '1731319200000', 'created': '2026-11-11T10:00:00.000Z',
                 'from': {'name': 'Erika Muster', 'email': 'erika.muster@netto.example'},
                 'text': 'Passt der Termin am Freitag?\nGrüße'},
                {'id': '1731319000000', 'created': '2026-11-11T09:55:00.000Z',
                 'from': {'name': 'Lucas Moskau', 'email': 'lucas@tiki.example'}, 'text': 'Hi Erika'}]})
        self.assertEqual(got[1], {
            'id': '19:revived@thread.v2', 'topic': 'Zollner Rahmenvertrag', 'type': 'group',
            'updated': '2026-11-05T12:00:00.000Z',
            'link': 'https://teams.microsoft.com/l/chat/19%3Arevived%40thread.v2/0',
            'members': [{'name': 'Hans Zoll', 'email': 'hans@zollner.example', 'userId': 'u-hans'}],
            'messages': [{'id': '1730800000000', 'created': '2026-11-05T12:00:00.000Z',
                          'from': {'name': 'Hans Zoll', 'email': 'hans@zollner.example'}, 'text': 'Neue Version anbei'}]})
        self.assertEqual(len(got), 2, '19:old was renamed recently but has no message since the cutoff')

    def test_chats_page_on_while_every_chat_is_newer(self):
        self.chat_routes()
        fake.routes[G + '/me/chats?$skiptoken=page2'] = (200, {'value': []})
        fake.routes[G + '/chats/19:old@thread.v2/messages'] = (200, {'value': []})
        fake.routes[G + '/chats/19:abc@thread.v2/messages?$skiptoken=page2'] = (200, {'value': []})
        got = json.loads(run('chats', '--since', '2026-01-01', '--json'))
        self.assertIn(G + '/me/chats?$skiptoken=page2', [u for u, _, _ in fake.calls])
        self.assertIn(G + '/chats/19:abc@thread.v2/messages?$skiptoken=page2', [u for u, _, _ in fake.calls])
        self.assertEqual([c['id'] for c in got], ['19:abc@thread.v2', '19:revived@thread.v2', '19:old@thread.v2'])
        self.assertEqual(len(got[0]['messages']), 3)

    def test_chats_text(self):
        self.chat_routes()
        self.assertEqual(run('chats', '1'),
                         '2026-11-11T10:00  Lucas Moskau, Erika Muster  (oneOnOne)\n'
                         '  2026-11-11T10:00  Erika Muster: Passt der Termin am Freitag? Grüße\n'
                         '  2026-11-11T09:55  Lucas Moskau: Hi Erika\n'
                         '  2026-10-20T08:00  Lucas Moskau: Kurze Frage\n')
        self.assertEqual(len(fake.calls), 2)

    def test_one_failing_chat_is_skipped_and_reported(self):
        for status in (500, 403):
            self.chat_routes()
            fake.routes[G + '/chats/19:revived@thread.v2/messages'] = (status, {'error': {'code': 'Boom'}})
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                got = json.loads(run('chats', '--since', '2026-11-01', '--json'))
            self.assertEqual([c['id'] for c in got], ['19:abc@thread.v2'])
            self.assertEqual(err.getvalue(), f'skipped chat 19:revived@thread.v2: {status}: {{"error": {{"code": "Boom"}}}}\n')

    def test_chats_with_25_members_fetch_the_full_list(self):
        self.chat_routes()
        member = lambda i: {'displayName': f'P{i}', 'userId': f'u{i}', 'email': f'p{i}@zollner.example'}
        chats = fixture('chats.json')
        chats['value'][1]['members'] = [member(i) for i in range(25)]
        fake.routes[G + '/me/chats'] = (200, chats)
        fake.routes[G + '/chats/19:revived@thread.v2/members'] = (200, {'value': [member(i) for i in range(30)]})
        got = json.loads(run('chats', '--since', '2026-11-01', '--json'))
        self.assertEqual(len(got[1]['members']), 30)
        self.assertEqual(got[1]['members'][29], {'name': 'P29', 'email': 'p29@zollner.example', 'userId': 'u29'})
        self.assertNotIn(G + '/chats/19:abc@thread.v2/members', [u for u, _, _ in fake.calls])

    def test_flags_only_on_commands_that_take_them(self):
        for argv, msg in [(('me', '--json'), '--json: not supported by me (only calendar, mail, read, chats)'),
                          (('calendar', '--since', '2026-11-01'), '--since: not supported by calendar (only mail, chats)'),
                          (('read', 'x', '--since', '2026-11-01'), '--since: not supported by read (only mail, chats)')]:
            with self.assertRaises(SystemExit) as e:
                run(*argv)
            self.assertEqual(e.exception.code, msg)
        self.assertEqual(fake.calls, [])

    def test_windows_zone_name_falls_back_to_utc(self):
        page = fixture('calendar-2.json')
        for t in ('start', 'end'):
            page['value'][0][t]['timeZone'] = 'W. Europe Standard Time'
        fake.routes = {G + '/me/calendarView': (200, page)}
        got = json.loads(run('calendar', '--json'))
        self.assertEqual((got[0]['start'], got[0]['end']), ('2026-11-12T14:00:00+00:00', '2026-11-12T15:00:00+00:00'))

    def test_graph_error_exits_with_status(self):
        fake.routes = {G + '/me/messages': (500, {'error': 'down'})}
        with self.assertRaises(SystemExit) as e:
            run('mail')
        self.assertEqual(e.exception.code, '500: {"error": "down"}')

    def test_chat_scope_only_behind_env_flag(self):
        self.assertNotIn('Chat.Read', m365.SCOPES)
        self.assertIn('Chat.Read', load({'M365_CHAT': '1'}).SCOPES)

    def test_token_never_printed(self):
        fake.routes = {G + '/me/messages/AAMkMSG1': (200, 'message.json'), G + '/me/messages': (200, 'messages.json')}
        self.assertNotIn('SECRET-TOKEN', run('read', 'AAMkMSG1', '--json') + run('mail', '1', '--json'))
        self.assertEqual(fake.calls[0][2]['Authorization'], 'Bearer SECRET-TOKEN')


if __name__ == '__main__':
    unittest.main()
