"""Offline model and source checks; no Android runtime is exercised."""
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'android/app/src/main/kotlin/io/voipgw/gateway/core'
ACTIVITY = ROOT / 'android/app/src/main/kotlin/io/voipgw/gateway/ui/MainActivity.kt'

class FakeObservation:
    def __init__(self): self.token, self.state, self.notifications = None, 'unknown', 0
    def begin(self):
        self.token, self.state = object(), 'unknown'
        self.notifications += 1
        return self.token
    def end(self, token):
        if token is self.token:
            self.token, self.state = None, 'unknown'
            self.notifications += 1
    def close(self, token):
        if token is self.token and self.state != 'terminal':
            self.state = 'terminal'
            self.notifications += 1

class TerminalObservationTest(unittest.TestCase):
    def test_instance_races_and_idempotence(self):
        o = FakeObservation(); old = o.begin(); o.close(old)
        current = o.begin(); o.close(old)
        self.assertEqual(o.state, 'unknown')
        o.close(current); o.close(current); o.close(old)
        self.assertEqual((o.state, o.notifications), ('terminal', 4))

    def test_stop_and_new_instance_reject_stale_callbacks(self):
        o = FakeObservation(); old = o.begin(); o.close(old); o.end(old); o.close(old)
        self.assertEqual(o.state, 'unknown')
        current = o.begin(); o.end(old); o.close(current); o.close(old)
        self.assertEqual(o.state, 'terminal')

    def test_wiring_preserves_terminal_gate(self):
        service = (CORE / 'GatewayService.kt').read_text(encoding='utf-8')
        observation = (CORE / 'GatewayConnectionObservation.kt').read_text(encoding='utf-8')
        activity = ACTIVITY.read_text(encoding='utf-8')
        close = service.partition('private fun finishConnection(')[2].partition('private fun acknowledgeAndFlush(')[0]
        self.assertLess(close.index('if (stopped || session !== active) return'), close.index('execution.close(active.connection)'))
        self.assertLess(close.index('execution.close(active.connection)'), close.index('terminalClosed(observationToken)'))
        self.assertIn('if (active.connection.terminalReason != null || !released)', close)
        self.assertIn('if (active.connection.terminalReason != null && GatewayConnectionObservation.state.terminalClosed(observationToken))', close)
        for effect in ('handler.removeCallbacks(heartbeat)', 'Credentials.notifyBindingObservers()', 'stopSelf()'):
            self.assertIn(effect, close.partition('val delay =')[0])
        stop = service.partition('private fun stopResources()')[2]
        self.assertLess(stop.index('endInstance(observationToken)'), stop.index('if (observationEnded)'))
        self.assertIn('if (observationEnded) GatewayConnectionObservation.state.notifyObservers()', stop)
        self.assertIn('session?.let { execution.close(it.connection) }', stop)
        self.assertIn('!terminal && ticket == reconnectTicket', close)
        self.assertIn('instance !== token', observation)
        self.assertIn('val closed = credentials.state() == BindingFence.State.TERMINAL ||', activity)
        self.assertIn('GatewayConnectionObservation.state.register(it)', activity)
        self.assertIn('GatewayConnectionObservation.state.unregister(it)', activity)
        self.assertIn('mainHandler.post { refreshConnection(); refreshStart() }', activity)
        self.assertIn('val startStatus', activity)
        self.assertIn('val connectionStatus', activity)

    def test_locales_have_distinct_connection_messages(self):
        for locale in ('values', 'values-en', 'values-zh-rHK'):
            path = ROOT / 'android/app/src/main/res' / locale / 'strings.xml'
            strings = {element.attrib['name']: element.text for element in ET.parse(path).getroot()}
            for key in ('gateway_connection_unknown', 'gateway_connection_terminal_closed'):
                self.assertTrue(strings[key], (locale, key))

if __name__ == '__main__': unittest.main()
