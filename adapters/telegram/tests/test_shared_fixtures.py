import asyncio
import json
from pathlib import Path
import unittest

from voipgw_tg.client import AdapterClient, validate
from voipgw_tg.ipc import FrameDecoder, encode_control, encode_frame


FIXTURES = Path(__file__).resolve().parents[3] / 'packages' / 'protocol' / 'fixtures'
INCOMING_TYPES = {
    'account.login', 'account.login.submit', 'account.logout',
    'message.send', 'call.dial', 'call.hangup', 'ack',
}


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding='utf-8'))


class MemoryWriter:
    def __init__(self):
        self.data = bytearray()

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
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
