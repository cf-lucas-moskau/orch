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
    """Graph and msal stand-ins: routes maps a URL to (status, fixture name); calls records every request."""
    granted = {'User.Read', 'Mail.Read', 'Mail.Read.Shared', 'Calendars.Read', 'Calendars.Read.Shared'}
    accounts = [{'username': 'lucas@tiki.example'}]

    def __init__(self):
        self.routes, self.calls = {}, []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, dict(params or {}), dict(headers or {})))
        status, name = self.routes[url]
        return Resp(status, fixture(name) if name else {'error': {'code': 'Forbidden'}})


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

    def test_chats_json_since(self):
        fake.granted.add('Chat.Read')
        fake.routes = {G + '/me/chats': (200, 'chats.json'),
                       G + '/chats/19:abc@thread.v2/messages': (200, 'chat-messages.json')}
        got = json.loads(run('chats', '--since', '2026-11-01', '--json'))
        self.assertEqual([u for u, _, _ in fake.calls], [G + '/me/chats', G + '/chats/19:abc@thread.v2/messages'])
        self.assertEqual(fake.calls[1][1]['$filter'], 'createdDateTime gt 2026-10-31T23:00:00Z')
        self.assertEqual(got, [{
            'id': '19:abc@thread.v2', 'topic': None, 'type': 'oneOnOne', 'updated': '2026-11-11T10:00:00.000Z',
            'link': 'https://teams.microsoft.com/l/chat/19%3Aabc%40thread.v2/0',
            'members': [{'name': 'Lucas Moskau', 'email': 'lucas@tiki.example', 'userId': 'u-lucas'},
                        {'name': 'Erika Muster', 'email': 'erika.muster@netto.example', 'userId': 'u-erika'}],
            'messages': [
                {'id': '1731319200000', 'created': '2026-11-11T10:00:00.000Z',
                 'from': {'name': 'Erika Muster', 'email': 'erika.muster@netto.example'},
                 'text': 'Passt der Termin am Freitag?\nGrüße'},
                {'id': '1731319000000', 'created': '2026-11-11T09:55:00.000Z',
                 'from': {'name': 'Lucas Moskau', 'email': 'lucas@tiki.example'}, 'text': 'Hi Erika'}]}])

    def test_chats_text(self):
        fake.granted.add('Chat.Read')
        fake.routes = {G + '/me/chats': (200, 'chats.json'),
                       G + '/chats/19:abc@thread.v2/messages': (200, 'chat-messages.json')}
        self.assertEqual(run('chats', '1'),
                         '2026-11-11T10:00  Lucas Moskau, Erika Muster  (oneOnOne)\n'
                         '  2026-11-11T10:00  Erika Muster: Passt der Termin am Freitag? Grüße\n'
                         '  2026-11-11T09:55  Lucas Moskau: Hi Erika\n')

    def test_chat_scope_only_behind_env_flag(self):
        self.assertNotIn('Chat.Read', m365.SCOPES)
        self.assertIn('Chat.Read', load({'M365_CHAT': '1'}).SCOPES)

    def test_token_never_printed(self):
        fake.routes = {G + '/me/messages/AAMkMSG1': (200, 'message.json'), G + '/me/messages': (200, 'messages.json')}
        self.assertNotIn('SECRET-TOKEN', run('read', 'AAMkMSG1', '--json') + run('mail', '1', '--json'))
        self.assertEqual(fake.calls[0][2]['Authorization'], 'Bearer SECRET-TOKEN')


if __name__ == '__main__':
    unittest.main()
