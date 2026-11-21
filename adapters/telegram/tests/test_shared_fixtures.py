import asyncio
import json
from pathlib import Path
import re
import unittest

from voipgw_tg.adapter import envelope, startup
from voipgw_tg.client import AdapterClient, validate
from voipgw_tg.ipc import FrameDecoder, encode_control, encode_frame


PROTOCOL = Path(__file__).resolve().parents[3] / 'packages' / 'protocol'
FIXTURES = PROTOCOL / 'fixtures'
INCOMING_TYPES = {
    'account.login', 'account.login.submit', 'account.logout',
    'message.send', 'call.dial', 'call.hangup', 'ack',
}


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


def ack(ref_id, ok=True, error=None):
    return envelope('ack', {'refId': ref_id, 'ok': ok, 'error': error})


class MemoryWriter:
    def __init__(self):
        self.data = bytearray()
        self.writes = asyncio.Queue()
        self.closed = False

    def write(self, data):
        self.data.extend(data)
        self.writes.put_nowait(data)

    async def next_message(self):
        [(kind, body)] = FrameDecoder().feed(await asyncio.wait_for(self.writes.get(), 1))
        assert kind == 1
        return json.loads(body)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


class SharedIpcFixtureTests(unittest.IsolatedAsyncioTestCase):
    def test_incoming_ipc_examples(self):
        cases = [row for row in fixture('ipc/messages.json') if row['valid']['type'] in INCOMING_TYPES]
        self.assertEqual(set(row['valid']['type'] for row in cases), INCOMING_TYPES)
        for row in cases:
            with self.subTest(message_type=row['valid']['type']):
                self.assertTrue(validate(row['valid']))
                self.assertFalse(validate(row['invalid']))

    def test_incoming_payload_boundaries(self):
        incoming = {row['valid']['type']: row['valid'] for row in fixture('ipc/messages.json')
                    if row['valid']['type'] in INCOMING_TYPES}
        cases = fixture('ipc/command-boundaries.json')
        self.assertTrue(cases)
        for row in cases:
            with self.subTest(case=row['name']):
                message = {**incoming[row['type']], 'payload': row['payload']}
                self.assertIs(validate(message), row['valid'])

    def test_ipc_envelope_id_boundaries(self):
        message = fixture('ipc/frames.json')['control']['message']
        for row in fixture('ulid-boundaries.json'):
            with self.subTest(device_id=row['id']):
                self.assertEqual(validate({**message, 'id': 'ipc_' + row['id'].removeprefix('dev_')}), row['valid'])

    def test_exact_framing_and_malformed_lengths_or_kind(self):
        frames = fixture('ipc/frames.json')
        control = bytes.fromhex(frames['control']['wireHex'])
        audio = bytes.fromhex(frames['audio']['wireHex'])
        audio_body = bytes([frames['audio']['channel']]) + bytes.fromhex(frames['audio']['mediaHex'])
        self.assertEqual(encode_control(frames['control']['message']), control)
        self.assertEqual(encode_frame(2, audio_body), audio)

        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(control[:3]), [])
        self.assertEqual(decoder.feed(control[3:] + audio), [(1, control[5:]), (2, audio_body)])
        for name, raw in frames['invalidFraming'].items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                FrameDecoder().feed(bytes.fromhex(raw))

    async def test_control_ingress_preserves_payload_and_matches_ack_reference(self):
        control = fixture('ipc/frames.json')['control']
        calls = []

        async def handle(kind, payload):
            calls.append((kind, payload))
            return True, None

        client = AdapterClient('unused', handle)
        writer = MemoryWriter()
        client.writer = writer
        reader = asyncio.StreamReader()
        wire = bytes.fromhex(control['wireHex'])
        receiving = asyncio.create_task(client._receive(reader))
        reader.feed_data(wire[:3])
        await asyncio.sleep(0)
        self.assertEqual(writer.data, b'')
        self.assertEqual(calls, [])
        reader.feed_data(wire[3:])
        reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await receiving
        await asyncio.gather(*client.dispatches)
        self.assertEqual(calls, [(control['message']['type'], control['message']['payload'])])
        [(kind, body)] = FrameDecoder().feed(writer.data)
        reply = json.loads(body)
        self.assertEqual((kind, reply['type']), (1, 'ack'))
        self.assertEqual(reply['payload'], {'refId': control['message']['id'], 'ok': True, 'error': None})

    async def test_invalid_ack_cannot_advance_startup(self):
        malformed_utf8 = bytes.fromhex(fixture('ipc/frames.json')['malformedUtf8Hex'])[5:]

        def with_invalid_utf8(ref):
            prefix = json.dumps({**ack(ref), 'ignored': ''})[:-2].encode('utf-8')
            return encode_frame(1, prefix + malformed_utf8 + b'"}')

        bad_cases = {
            'positive with error': (lambda ref: encode_control(ack(ref, True, 'INTERNAL')), 'invalid envelope or ack'),
            'negative with null': (lambda ref: encode_control(ack(ref, False, None)), 'invalid envelope or ack'),
            'unknown error code': (lambda ref: encode_control(ack(ref, False, 'NOT_A_SHARED_CODE')), 'invalid envelope or ack'),
            'numeric reference': (lambda ref: encode_control(ack(123)), 'invalid envelope or ack'),
            'out-of-range timestamp': (lambda ref: encode_control({**ack(ref), 'ts': 8_640_000_000_000_001}), 'invalid envelope or ack'),
            'malformed UTF-8 in otherwise valid ACK': (with_invalid_utf8, 'invalid control JSON'),
        }
        for value in (float('nan'), float('inf'), -float('inf')):
            bad_cases[str(value)] = (lambda ref, value=value: encode_control({**ack(ref), 'ignored': value}), 'invalid control JSON')
        for label, (make_frame, error) in bad_cases.items():
            with self.subTest(case=label):
                client = AdapterClient('unused', ack_timeout=0.2)
                reader, writer = asyncio.StreamReader(), MemoryWriter()
                connected = asyncio.create_task(client.connected(reader, writer))
                try:
                    hello = await writer.next_message()
                    self.assertEqual(hello['type'], 'adapter.hello')
                    self.assertIn(hello['id'], client.pending)
                    reader.feed_data(make_frame(hello['id']))
                    with self.assertRaisesRegex(ValueError, error):
                        await asyncio.wait_for(connected, 1)
                    self.assertTrue(writer.closed)
                    self.assertTrue(writer.writes.empty())
                    self.assertIsNone(client.ready_at)
                    self.assertIsNone(client.writer)
                    self.assertFalse(client.pending)
                finally:
                    connected.cancel()
                    await asyncio.gather(connected, return_exceptions=True)

    async def test_ack_selects_exact_pending_reference_and_ignores_expired_ack(self):
        client = AdapterClient('unused', ack_timeout=1)
        reader, writer = asyncio.StreamReader(), MemoryWriter()
        connected = asyncio.create_task(client.connected(reader, writer))
        try:
            hello = await writer.next_message()
            self.assertEqual(hello['type'], 'adapter.hello')
            for ref in ('', 'opaque-ref', hello['id'].lower(), hello['id'] + ' '):
                reader.feed_data(encode_control(ack(ref)))
            await asyncio.sleep(0)
            self.assertTrue(writer.writes.empty())
            self.assertFalse(connected.done())
            self.assertIn(hello['id'], client.pending)
            reader.feed_data(encode_control(ack(hello['id'])))
            caps = await writer.next_message()
            self.assertEqual(caps['type'], 'capabilities')
            self.assertFalse(any(caps['payload'].values()))
            reader.feed_data(encode_control(ack(caps['id'])))
            state = await writer.next_message()
            self.assertEqual(state['type'], 'account.state')
            self.assertEqual(state['payload']['state'], 'logged_out')
            # The shared TextDecoder accepts a leading UTF-8 BOM.
            reader.feed_data(encode_frame(1, b'\xef\xbb\xbf' + encode_control(ack(state['id']))[5:]))

            client.ack_timeout = 0.01
            expired = asyncio.create_task(client.send(startup()[2]))
            expired_message = await writer.next_message()
            with self.assertRaises(asyncio.TimeoutError):
                await expired
            self.assertNotIn(expired_message['id'], client.pending)
            self.assertTrue(writer.writes.empty())
            self.assertIsNotNone(client.ready_at)

            client.ack_timeout = 1
            sending = asyncio.create_task(client.send(startup()[2]))
            selected = await writer.next_message()
            reader.feed_data(encode_control(ack(expired_message['id'])))
            await asyncio.sleep(0)
            self.assertFalse(sending.done())
            self.assertTrue(writer.writes.empty())
            exact = ack(selected['id'])
            reader.feed_data(encode_control(exact))
            self.assertEqual(await sending, exact['payload'])
        finally:
            connected.cancel()
            await asyncio.gather(connected, return_exceptions=True)

    async def test_old_reader_cannot_settle_ack_for_current_writer(self):
        client = AdapterClient('unused', ack_timeout=1)
        client.writer = MemoryWriter()
        old_reader = asyncio.StreamReader()
        old_receive = asyncio.create_task(client._receive(old_reader))
        await asyncio.sleep(0)
        writer = MemoryWriter()
        client.writer = writer
        sending = asyncio.create_task(client.send(startup()[2]))
        try:
            selected = await writer.next_message()
            stale, exact = ack(selected['id']), ack(selected['id'], False, 'INTERNAL')
            old_reader.feed_data(encode_control(stale)); old_reader.feed_eof()
            with self.assertRaisesRegex(ConnectionError, 'connection replaced'):
                await asyncio.wait_for(old_receive, 1)
            self.assertFalse(sending.done())
            reader = asyncio.StreamReader()
            reader.feed_data(encode_control(exact)); reader.feed_eof()
            with self.assertRaises(asyncio.IncompleteReadError):
                await client._receive(reader)
            self.assertEqual(await sending, exact['payload'])
        finally:
            for task in (old_receive, sending):
                task.cancel()
            await asyncio.gather(old_receive, sending, return_exceptions=True)

    async def test_all_shared_negative_ack_codes_are_preserved(self):
        source = (PROTOCOL / 'src' / 'errors.ts').read_text(encoding='utf-8')
        declared = re.search(r'export const ERROR_CODES\s*=\s*\[([^\]]+)\]', source)
        self.assertIsNotNone(declared)
        codes = re.findall(r"""['"]([A-Z_]+)['"]""", declared[1])
        self.assertIn('TIMEOUT_UNKNOWN', codes)
        client = AdapterClient('unused', ack_timeout=1)
        writer = MemoryWriter()
        client.writer = writer
        reader = asyncio.StreamReader()
        receiving = asyncio.create_task(client._receive(reader))
        try:
            for error in codes:
                sending = asyncio.create_task(client.send(startup()[2]))
                selected = await writer.next_message()
                exact = ack(selected['id'], False, error)
                reader.feed_data(encode_control(exact))
                self.assertEqual(await sending, exact['payload'])
        finally:
            receiving.cancel()
            await asyncio.gather(receiving, return_exceptions=True)

    async def test_command_timestamps_match_the_shared_numeric_range(self):
        control = fixture('ipc/frames.json')['control']['message']
        cases = [(0, True), (1.0, True), (8_640_000_000_000_000, True), (8_640_000_000_000_001, False),
                 (9_007_199_254_740_991, False), (-1, False), (1.5, False), (True, False), ('1', False)]
        calls = []

        async def handle(kind, payload):
            calls.append((kind, payload))
            return True, None

        client = AdapterClient('unused', handle)
        writer, reader = MemoryWriter(), asyncio.StreamReader()
        client.writer = writer
        messages = [{**envelope(control['type'], control['payload']), 'ts': ts} for ts, _ in cases]
        reader.feed_data(b''.join(encode_control(message) for message in messages)); reader.feed_eof()
        with self.assertRaises(asyncio.IncompleteReadError):
            await client._receive(reader)
        await asyncio.gather(*client.dispatches)
        self.assertEqual(calls, [(control['type'], control['payload']) for _, valid in cases if valid])
        replies = [json.loads(body)['payload'] for _, body in FrameDecoder().feed(writer.data)]
        self.assertEqual(len(replies), len(messages))
        self.assertEqual({reply['refId']: reply for reply in replies}, {
            message['id']: {'refId': message['id'], 'ok': valid, 'error': None if valid else 'BAD_MESSAGE'}
            for message, (_, valid) in zip(messages, cases)
        })

    async def test_client_ingress_rejects_malformed_utf8_and_unsupported_audio(self):
        frames = fixture('ipc/frames.json')
        for wire_hex, error in [(frames['malformedUtf8Hex'], 'invalid control JSON'),
                                (frames['audio']['wireHex'], 'audio unsupported')]:
            with self.subTest(error=error):
                client = AdapterClient('unused')
                writer = MemoryWriter()
                client.writer = writer
                reader = asyncio.StreamReader()
                reader.feed_data(bytes.fromhex(wire_hex))
                reader.feed_eof()
                with self.assertRaisesRegex(ValueError, error):
                    await client._receive(reader)
                self.assertFalse(client.dispatches)
                self.assertEqual(writer.data, b'')
