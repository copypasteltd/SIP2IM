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

class GatedWriter(Writer):
    def __init__(self):
        super().__init__()
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.drain_cancelled = asyncio.Event()
        self.closed = False

    async def drain(self):
        self.entered.set()
        try: await self.release.wait()
        except asyncio.CancelledError:
            self.drain_cancelled.set()
            raise

    def close(self): self.closed = True
    async def wait_closed(self): pass


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

    async def _feed_ack(self, client, message, ok=True):
        reader = asyncio.StreamReader()
        reply = envelope('ack', {'refId':message['id'], 'ok':ok, 'error':None if ok else 'INTERNAL'})
        reader.feed_data(encode_control(reply)); reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError): await client._receive(reader)
        return reply['payload']

    async def test_ack_deadline_is_checked_when_processed_before_timer_delivery(self):
        for processed_at, ok in [(9.999, True), (9.999, False), (10.0, True), (10.0, False)]:
            with self.subTest(processed_at=processed_at, ok=ok):
                elapsed = 0.0
                client = AdapterClient('unused', clock=lambda: elapsed)
                writer = Writer(); client.writer = writer
                report = envelope('account.state', {})
                send = asyncio.create_task(client.send(report))
                try:
                    await asyncio.sleep(0); await asyncio.sleep(0)
                    self.assertTrue(client.pending[report['id']].drained)
                    elapsed = processed_at
                    await self._feed_ack(client, envelope('account.state', {}))
                    self.assertIn(report['id'], client.pending)
                    reply = await self._feed_ack(client, report, ok)
                    if processed_at < 10.0:
                        self.assertEqual(await send, reply)
                    else:
                        with self.assertRaisesRegex(asyncio.TimeoutError, 'ack timeout; outcome unknown'):
                            await send
                    await self._feed_ack(client, report, not ok)
                    self.assertFalse(client.pending)
                    self.assertEqual(bytes(writer.data), encode_control(report))
                finally:
                    send.cancel()
                    await asyncio.gather(send, return_exceptions=True)

    async def test_first_ack_and_drain_share_the_original_window(self):
        for drained_at in (9.999, 10.0):
            with self.subTest(drained_at=drained_at):
                elapsed = 0.0
                client = AdapterClient('unused', clock=lambda: elapsed)
                writer = GatedWriter(); client.writer = writer
                report = envelope('account.state', {})
                send = asyncio.create_task(client.send(report))
                try:
                    await asyncio.wait_for(writer.entered.wait(), 1)
                    first = await self._feed_ack(client, report, False)
                    await self._feed_ack(client, report, True)
                    self.assertFalse(send.done())
                    elapsed = drained_at
                    writer.release.set()
                    if drained_at < 10.0:
                        self.assertEqual(await send, first)
                    else:
                        with self.assertRaisesRegex(asyncio.TimeoutError, 'ack timeout; outcome unknown'):
                            await send
                    self.assertFalse(client.pending)
                    self.assertEqual(bytes(writer.data), encode_control(report))
                finally:
                    writer.release.set(); send.cancel()
                    await asyncio.gather(send, return_exceptions=True)

    async def test_watchdog_unblocks_a_stalled_drain_without_waiting_for_an_ack(self):
        writer = GatedWriter()
        client = AdapterClient('unused', ack_timeout=0.02); client.writer = writer
        report = envelope('account.state', {})
        sending = asyncio.create_task(client.send(report))
        try:
            await asyncio.wait_for(writer.entered.wait(), 1)
            with self.assertRaisesRegex(asyncio.TimeoutError, 'ack timeout; outcome unknown'):
                await asyncio.wait_for(sending, 1)
            self.assertTrue(writer.drain_cancelled.is_set())
            self.assertFalse(client.pending)
            self.assertEqual(bytes(writer.data), encode_control(report))
        finally:
            writer.release.set(); sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)

    async def test_cancelling_startup_retires_its_send_and_drain(self):
        writer = GatedWriter()
        client = AdapterClient('unused')
        connecting = asyncio.create_task(client.connected(asyncio.StreamReader(), writer))
        try:
            await asyncio.wait_for(writer.entered.wait(), 1)
            connecting.cancel()
            with self.assertRaises(asyncio.CancelledError): await asyncio.wait_for(connecting, 1)
            self.assertTrue(writer.drain_cancelled.is_set())
            self.assertTrue(writer.closed)
            self.assertFalse(client.pending)
            self.assertIsNone(client.writer)
            self.assertIsNone(client.ready_at)
            from voipgw_tg.ipc import FrameDecoder
            frames = FrameDecoder().feed(writer.data)
            self.assertEqual(len(frames), 1)
            self.assertEqual(json.loads(frames[0][1])['type'], 'adapter.hello')
        finally:
            writer.release.set(); connecting.cancel()
            await asyncio.gather(connecting, return_exceptions=True)

    async def test_observed_eof_retires_other_pending_reports(self):
        elapsed = 0.0
        writer = GatedWriter(); writer.release.set()
        reader = asyncio.StreamReader()
        client = AdapterClient('unused', clock=lambda: elapsed)
        async def no_startup(): return []
        client.startup_provider = no_startup
        connected = asyncio.create_task(client.connected(reader, writer))
        send = None
        try:
            await asyncio.sleep(0)
            report = envelope('account.state', {})
            send = asyncio.create_task(client.send(report))
            await asyncio.wait_for(writer.entered.wait(), 1)
            elapsed = 9.999
            reader.feed_eof()
            with self.assertRaises(asyncio.IncompleteReadError): await asyncio.wait_for(connected, 1)
            elapsed = 10.0
            with self.assertRaisesRegex(ConnectionError, 'disconnected; outcome unknown'): await send
            self.assertIsNone(client.writer)
            self.assertFalse(client.pending)
            self.assertTrue(writer.closed)
            self.assertEqual(bytes(writer.data), encode_control(report))
        finally:
            connected.cancel()
            if send is not None:
                send.cancel()
                await asyncio.gather(connected, send, return_exceptions=True)
            else:
                await asyncio.gather(connected, return_exceptions=True)

    async def test_duplicate_live_report_does_not_overwrite_the_original_future(self):
        writer = GatedWriter()
        client = AdapterClient('unused'); client.writer = writer
        report = envelope('account.state', {})
        sending = asyncio.create_task(client.send(report))
        try:
            await asyncio.wait_for(writer.entered.wait(), 1)
            original = client.pending[report['id']]
            with self.assertRaisesRegex(ValueError, 'already pending'): await client.send(report)
            self.assertIs(client.pending[report['id']], original)
            writer.release.set()
            result = await self._feed_ack(client, report)
            self.assertEqual(await sending, result)
            self.assertEqual(bytes(writer.data), encode_control(report))
            self.assertFalse(client.pending)
        finally:
            writer.release.set(); sending.cancel()
            await asyncio.gather(sending, return_exceptions=True)

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
