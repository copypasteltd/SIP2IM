# Offline source and model checks; this does not execute Kotlin or Android.
from pathlib import Path
import unittest

ANDROID = Path(__file__).resolve().parents[1] / "android"
SOURCE = ANDROID / "protocol/src/main/kotlin/io/voipgw/protocol/SmsParts.kt"


def assemble(parts):
    if not parts or any(part[0] != parts[0][0] for part in parts):
        raise ValueError("empty parts or mixed senders")
    return parts[0][0], "".join(part[1] for part in parts), parts[0][2], len(parts)


class SmsPartsSourceTest(unittest.TestCase):
    def test_source_contract(self):
        source = SOURCE.read_text(encoding="utf-8")
        body = source.split("fun assemble(parts: List<Part>): Message {", 1)[1].split("\n    }", 1)[0]
        self.assertIn("require(parts.isNotEmpty())", body)
        self.assertIn("require(parts.all { it.from == first.from })", body)
        self.assertIn('Message(first.from, parts.joinToString("") { it.body }, first.receivedAt, parts.size)', body)
        self.assertEqual(body.count("require("), 2)
        self.assertNotIn("it.receivedAt", body)

    def test_receiver_persists_before_notifying_without_starting_the_gateway(self):
        app = ANDROID / "app/src/main/kotlin/io/voipgw/gateway"
        receiver = (app / 'sms/SmsReceiver.kt').read_text(encoding='utf-8')
        hook = (app / 'core/OutboxWake.kt').read_text(encoding='utf-8')
        stages = ('extras.get("pdus")', 'for (raw in pdus)', 'SmsParts.assemble(parts)',
                  'Outbox.shared(context).enqueue("sms.received", payload.toString())', 'OutboxWake.notifyCommitted()')
        positions = [receiver.index(stage) for stage in stages]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('put("subId", JSONObject.NULL)', receiver)
        for unsupported in ('startService(', 'startForegroundService(', 'GatewayStart'):
            self.assertNotIn(unsupported, receiver)
            self.assertNotIn(unsupported, hook)

    def test_model_large_gap_order_and_rejections(self):
        parts = [("sender", "first", 2**63 - 1), ("sender", " second", -(2**63)), ("sender", " third", 0)]
        self.assertEqual(assemble(parts), ("sender", "first second third", 2**63 - 1, 3))
        for invalid in ([], [("a", "x", 0), ("b", "y", 0)]):
            with self.assertRaises(ValueError):
                assemble(invalid)


if __name__ == "__main__":
    unittest.main()
