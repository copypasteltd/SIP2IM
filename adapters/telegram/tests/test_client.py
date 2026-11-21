import asyncio
import json
import struct
import unittest
from unittest.mock import patch
from voipgw_tg.adapter import envelope
from voipgw_tg.client import AdapterClient
from voipgw_tg.fake_platform import FakePlatform
from voipgw_tg.ipc import encode_control

class Writer:
    def __init__(self): self.data = bytearray()
    def write(self, data): self.data.extend(data)
    async def drain(self): pass

class ClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_backoff_resets_only_after_stable_connection(self):
        client = AdapterClient('unused')
        durations = []
        attempts = 0
        async def connect(path):
            nonlocal attempts
            attempts += 1
            if attempts in (1, 2, 4, 5): raise OSError('offline')
            return None, None
        async def connected(reader, writer):
            client.ready_at = asyncio.get_running_loop().time() - 31
            raise ConnectionError('closed')
        async def sleep(delay):
            durations.append(delay)
            if len(durations) == 5: raise asyncio.CancelledError()
        with patch('voipgw_tg.client.asyncio.open_unix_connection', connect, create=True), patch.object(client, 'connected', connected), patch('voipgw_tg.client.asyncio.sleep', sleep):
            with self.assertRaises(asyncio.CancelledError): await client.run()
        self.assertEqual(durations, [1.0, 2.0, 1.0, 2.0, 4.0])

    async def test_fake_dedup_and_invalid(self):
        fake = FakePlatform()
        client = AdapterClient('unused', fake.handle)
        writer = Writer(); client.writer = writer
        reader = asyncio.StreamReader()
        command = envelope('message.send', {'userId':'fake', 'text':'hello'})
        bad = envelope('call.dial', {'userId':'fake'})
        reader.feed_data(encode_control(command) * 2 + encode_control(bad)); reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError): await client._receive(reader)
        await asyncio.gather(*client.dispatches)
        self.assertEqual(fake.messages, [('fake', 'hello')])
        from voipgw_tg.ipc import FrameDecoder
        replies = [json.loads(body) for _, body in FrameDecoder().feed(writer.data)]
        self.assertEqual(sorted(reply['payload']['ok'] for reply in replies), [False, True, True])
        self.assertEqual(next(reply for reply in replies if not reply['payload']['ok'])['payload']['error'], 'BAD_MESSAGE')
    async def test_handler_can_send_and_receive_ack_without_deadlock(self):
        client = AdapterClient('unused', ack_timeout=0.5)
        writer = Writer(); client.writer = writer
        completed = asyncio.Event()
        async def handler(kind, payload):
            result = await client.send(envelope('account.state', {}))
            completed.set()
            return result['ok'], None
        client.handler = handler
        reader = asyncio.StreamReader()
        receiving = asyncio.create_task(client._receive(reader))
        command = envelope('message.send', {'userId': 'fake', 'text': 'hello'})
        reader.feed_data(encode_control(command))
        from voipgw_tg.ipc import FrameDecoder
        for _ in range(100):
            await asyncio.sleep(0.001)
            frames = FrameDecoder().feed(writer.data)
            if frames: break
        outbound = json.loads(frames[0][1])
        reader.feed_data(encode_control(envelope('ack', {'refId': outbound['id'], 'ok': True, 'error': None})))
        await asyncio.wait_for(completed.wait(), 0.2)
        await asyncio.gather(*client.dispatches)
        replies = [json.loads(body) for _, body in FrameDecoder().feed(writer.data)]
        self.assertEqual(replies[-1]['payload']['refId'], command['id'])
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError): await receiving

    async def test_eof_is_observed_while_handler_is_pending(self):
        gate = asyncio.Event(); entered = asyncio.Event()
        async def handler(kind, payload):
            entered.set(); await gate.wait(); return True, None
        client = AdapterClient('unused', handler); client.writer = Writer()
        reader = asyncio.StreamReader()
        receiving = asyncio.create_task(client._receive(reader))
        reader.feed_data(encode_control(envelope('message.send', {'userId': 'fake', 'text': 'hello'})))
        await asyncio.wait_for(entered.wait(), 0.2)
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await asyncio.wait_for(receiving, 0.2)
        gate.set(); await asyncio.gather(*client.dispatches)

    async def test_inflight_duplicate_does_not_execute_or_ack_wrong_connection(self):
        gate = asyncio.Event(); entered = asyncio.Event(); calls = []
        async def handler(kind, payload):
            calls.append(kind); entered.set(); await gate.wait(); return True, None
        client = AdapterClient('unused', handler)
        old = Writer(); new = Writer(); client.writer = old
        command = envelope('message.send', {'userId': 'fake', 'text': 'hello'})
        first = asyncio.create_task(client._dispatch(command, old))
        await entered.wait()
        client.writer = new
        second = asyncio.create_task(client._dispatch(command, new))
        await asyncio.sleep(0); gate.set(); await asyncio.gather(first, second)
        self.assertEqual(len(calls), 1)
        self.assertEqual(old.data, b'')
        from voipgw_tg.ipc import FrameDecoder
        replies = [json.loads(body) for _, body in FrameDecoder().feed(new.data)]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0]['payload']['refId'], command['id'])

    async def test_ack_timeout_no_retry(self):
        client = AdapterClient('unused', ack_timeout=0.01); writer = Writer(); client.writer = writer
        with self.assertRaises(asyncio.TimeoutError): await client.send(envelope('account.state', {}))
        from voipgw_tg.ipc import FrameDecoder
        self.assertEqual(len(FrameDecoder().feed(writer.data)), 1)
        self.assertEqual(client.pending, {})
    async def test_ack_requires_error_field(self):
        client = AdapterClient('unused', ack_timeout=0.01); client.writer = Writer()
        message = envelope('account.state', {})
        sending = asyncio.create_task(client.send(message)); await asyncio.sleep(0)
        reader = asyncio.StreamReader()
        reader.feed_data(encode_control(envelope('ack', {'refId':message['id'], 'ok':True})))
        reader.feed_eof()
        with self.assertRaises(ValueError): await client._receive(reader)
        with self.assertRaises(asyncio.TimeoutError): await sending

    async def test_ack_matches_reference(self):
        client = AdapterClient('unused', ack_timeout=1); writer = Writer(); client.writer = writer
        message = envelope('account.state', {})
        sending = asyncio.create_task(client.send(message)); await asyncio.sleep(0)
        reader = asyncio.StreamReader(); reader.feed_data(encode_control(envelope('ack', {'refId':message['id'], 'ok':True, 'error':None}))); reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError): await client._receive(reader)
        self.assertTrue((await sending)['ok'])
