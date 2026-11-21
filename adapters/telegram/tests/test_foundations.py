import json
import struct
import unittest
from voipgw_tg.adapter import handle, startup
from voipgw_tg.ipc import FrameDecoder, MAX_FRAME, encode_control, encode_frame

class AdapterTests(unittest.TestCase):
    def test_startup(self):
        hello, capabilities, state = startup()
        self.assertEqual([hello['type'], capabilities['type'], state['type']], ['adapter.hello', 'capabilities', 'account.state'])
        self.assertTrue(all(not value for value in capabilities['payload'].values()))
        self.assertRegex(hello['id'], r'^ipc_[0-9A-HJKMNP-TV-Z]{26}$')
    def test_command(self):
        self.assertEqual(handle({'type': 'call.dial', 'id': 'ipc_test'})['payload'], {'refId': 'ipc_test', 'ok': False, 'error': 'CAPABILITY_UNSUPPORTED'})
        self.assertIsNone(handle({'type': 'ack'}))
    def test_frames(self):
        first = encode_control({'type': 'hello'})
        second = encode_frame(2, b'\x05audio')
        decoder = FrameDecoder()
        self.assertEqual(decoder.feed(first[:3]), [])
        frames = decoder.feed(first[3:] + second)
        self.assertEqual(json.loads(frames[0][1]), {'type': 'hello'})
        self.assertEqual(frames[1], (2, b'\x05audio'))
    def test_invalid_frames(self):
        for length in (0, MAX_FRAME + 1):
            with self.assertRaises(ValueError): FrameDecoder().feed(struct.pack('>I', length))
        with self.assertRaises(ValueError): FrameDecoder().feed(struct.pack('>I', 1) + b'\x03')
        with self.assertRaises(ValueError): encode_frame(1, b'x' * MAX_FRAME)
