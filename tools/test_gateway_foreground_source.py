"""Offline startup ordering checks; these do not execute Android lifecycle code."""
from pathlib import Path
import unittest

SERVICE = Path(__file__).resolve().parents[1] / "android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt"


class GatewayForegroundSourceTest(unittest.TestCase):
    def test_foreground_promotion_precedes_start_registration(self):
        source = SERVICE.read_text(encoding="utf-8")
        create = source.partition("override fun onCreate()")[2].partition("override fun onStartCommand(")[0]
        self.assertLess(create.index("startForeground("), create.index("OutboxWake.register("))
        self.assertLess(create.index("startForeground("), create.index("registerOnSharedPreferenceChangeListener("))
        for startup_effect in ("connect()", "handler.post(heartbeat)", "drain.wake()", "recoverUnknown("):
            self.assertNotIn(startup_effect, create)
        self.assertRegex(create, r"catch \(failure: Throwable\)\s*\{\s*stopResources\(\)\s*throw failure")

    def test_only_durably_bound_start_requests_can_connect(self):
        source = SERVICE.read_text(encoding="utf-8")
        start = source.partition("override fun onStartCommand(")[2].partition("override fun onBind(")[0]
        bound_gate = "if (!stopped && !terminal && credentials.state() == BindingFence.State.BOUND)"
        self.assertLess(start.index(bound_gate), start.index("connect()"))
        self.assertIn("if (!connectionAttempted && session == null) connect()", start)
        self.assertIn("if (!admitted) stopSelf(startId)", start)
        self.assertIn("if (admitted) START_STICKY else START_NOT_STICKY", start)
        connect = source.partition("private fun connect()")[2].partition("private fun listener(")[0]
        self.assertLess(connect.index("val connection = execution.open()"), connect.index("client.newWebSocket("))
        no_owner = connect.partition("if (connection == null) {")[2].partition("val active =")[0]
        self.assertIn("stopSelf()", no_owner)
        self.assertIn("return", no_owner)


if __name__ == "__main__":
    unittest.main()
