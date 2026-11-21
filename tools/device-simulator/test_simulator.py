import time
import unittest

from simulator import snapshot


class SnapshotTest(unittest.TestCase):
    def test_probe_timestamps_use_current_clock(self):
        before = time.time_ns() // 1_000_000
        for count in (1, 2):
            result = snapshot(count)
            after = time.time_ns() // 1_000_000
            self.assertEqual(len(result["sims"]), count)
            self.assertEqual(len(result["probes"]), 9)
            for probe in result["probes"].values():
                self.assertEqual(probe["result"], "untested")
                self.assertIsNone(probe["detail"])
                self.assertIsInstance(probe["probedAt"], int)
                self.assertTrue(before <= probe["probedAt"] <= after)

    def test_invalid_count(self):
        with self.assertRaises(ValueError):
            snapshot(3)


if __name__ == "__main__":
    unittest.main()
