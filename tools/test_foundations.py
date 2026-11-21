import importlib.util
from pathlib import Path
import unittest
ROOT = Path(__file__).parent

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
probe = load('probe', 'audio-probe/audio_probe.py')
simulator = load('simulator', 'device-simulator/simulator.py')
devices = load('devices', 'shizuku-autostart/devices.py')
prompt = load('prompt', 'prompt-builder/validate.py')
class ToolTests(unittest.TestCase):
    def test_audio(self):
        frame = probe.sine_frame()
        self.assertEqual(len(frame), 1920)
        self.assertAlmostEqual(probe.rms(frame), 7071, delta=2)
        with self.assertRaises(ValueError): probe.rms(b'x')
    def test_snapshot(self):
        self.assertEqual(len(simulator.snapshot(2)['sims']), 2)
        with self.assertRaises(ValueError): simulator.snapshot(3)
    def test_adb_listing(self):
        self.assertEqual(devices.authorized_serials('List of devices attached\na device product:x\nb unauthorized\nc offline\n'), ['a'])
    def test_prompt(self):
        prompt.validate(bytes(64000))
        with self.assertRaises(ValueError): prompt.validate(b'bad')
        with self.assertRaises(ValueError): prompt.validate(b'\x01' + bytes(63999))
