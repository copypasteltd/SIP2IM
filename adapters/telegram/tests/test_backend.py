import asyncio
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from voipgw_tg.backend import TelegramBackend

class SessionPasswordNeededError(Exception): pass

class FakeClient:
    def __init__(self): self.connected = False; self.authorized = False; self.sent = []; self.require_password = False
    def add_event_handler(self, callback, event): self.callback = callback
    def is_connected(self): return self.connected
    async def connect(self): self.connected = True
    async def is_user_authorized(self): return self.authorized
    async def send_code_request(self, phone): self.phone = phone; return SimpleNamespace(phone_code_hash='hash')
    async def sign_in(self, **kwargs):
        if 'code' in kwargs and self.require_password: raise SessionPasswordNeededError()
        self.authorized = True
    async def get_me(self): return SimpleNamespace(id=42, username='tester')
    async def send_message(self, user, text): self.sent.append((user, text))
    async def log_out(self): self.authorized = False; self.connected = False

class BackendTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.events = []
        async def emit(event): self.events.append(event); return {'ok': True}
        self.client = FakeClient(); self.backend = TelegramBackend(self.client, object(), emit)

    async def login(self, password=False):
        self.client.require_password = password
        self.assertEqual(await self.backend.handle('account.login', {}), (True, None))
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'phone','value':'+100000'}), (True, None))
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'code','value':'123'}), (True, None))
        if password: self.assertEqual(await self.backend.handle('account.login.submit', {'step':'password','value':'secret'}), (True, None))

    async def test_login_send_logout_and_voice(self):
        startup = await self.backend.startup()
        self.assertTrue(startup[1]['payload']['login']); self.assertFalse(startup[1]['payload']['dial'])
        self.assertEqual(await self.backend.handle('message.send', {'userId':'9','text':'hi'}), (False, 'CHANNEL_UNAVAILABLE'))
        await self.login(True)
        self.assertEqual([e['payload']['step'] for e in self.events if e['type']=='login.step'], ['phone','code','password'])
        self.assertEqual(await self.backend.handle('message.send', {'userId':'9','text':'hi'}), (True, None))
        self.assertEqual(self.client.sent, [(9, 'hi')])
        self.assertEqual(await self.backend.handle('message.send', {'userId':'@foo','text':'hi'}), (False, 'BAD_MESSAGE'))
        self.assertEqual(await self.backend.handle('call.dial', {}), (False, 'CAPABILITY_UNSUPPORTED'))
        self.assertEqual(await self.backend.handle('account.logout', {}), (True, None))
        self.assertEqual(self.backend.state['state'], 'logged_out')
        self.assertNotIn('secret', str(self.events))

    async def test_invalid_step_and_failure_do_not_leak(self):
        await self.backend.handle('account.login', {})
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'code','value':'123'}), (False, 'BAD_MESSAGE'))
        async def fail(phone): raise ValueError('sensitive')
        self.client.send_code_request = fail
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'phone','value':'123'}), (False, 'TIMEOUT_UNKNOWN'))
        self.assertEqual(self.backend.step, 'phone')

    async def test_private_incoming_message_and_filtering(self):
        sender = SimpleNamespace(first_name='Alice', username=None, contact=True)
        class Event:
            is_private=True; out=False; raw_text='hello'; sender_id=9; id=33
            date=datetime(2024,1,1,tzinfo=timezone.utc); message=SimpleNamespace(fwd_from=None)
            async def get_sender(self): return sender
        event=Event(); await self.client.callback(event)
        self.assertEqual(self.events[-1]['payload'], {'platformMessageId':'33','senderId':'9','senderName':'Alice','chatType':'private','forwarded':False,'isContact':True,'text':'hello','ts':1704067200000})
        event.is_private=False; await self.client.callback(event)
        self.assertEqual(len(self.events), 1)

    async def test_reconnect_replays_pending_step_after_lost_ack(self):
        await self.backend.handle('account.login', {})
        async def lost(event): raise asyncio.TimeoutError()
        self.backend.emit = lost
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'phone','value':'+100000'}), (False, 'TIMEOUT_UNKNOWN'))
        self.assertEqual(self.backend.step, 'code')
        messages = await self.backend.startup()
        self.assertEqual(messages[2]['payload']['state'], 'login_pending')
        self.assertEqual(messages[3]['payload']['step'], 'code')
        self.assertEqual(self.client.phone, '+100000')

    async def test_lost_state_ack_after_signin_recovers_authorized_state(self):
        await self.backend.handle('account.login', {})
        await self.backend.handle('account.login.submit', {'step':'phone','value':'+100000'})
        async def lost(event): raise asyncio.TimeoutError()
        self.backend.emit = lost
        self.assertEqual(await self.backend.handle('account.login.submit', {'step':'code','value':'123'}), (False, 'TIMEOUT_UNKNOWN'))
        messages = await self.backend.startup()
        self.assertEqual(messages[2]['payload']['state'], 'logged_in')
        self.assertEqual(len(messages), 3)

    async def test_send_and_logout_are_serialized(self):
        await self.login()
        entered, release = asyncio.Event(), asyncio.Event()
        async def send(user, text):
            entered.set(); await release.wait(); self.client.sent.append((user,text))
        self.client.send_message = send
        sending = asyncio.create_task(self.backend.handle('message.send', {'userId':'9','text':'hi'}))
        await entered.wait()
        logout = asyncio.create_task(self.backend.handle('account.logout', {}))
        await asyncio.sleep(0)
        self.assertTrue(self.client.authorized)
        release.set()
        self.assertEqual(await sending, (True, None))
        self.assertEqual(await logout, (True, None))
        self.assertFalse(self.client.authorized)
