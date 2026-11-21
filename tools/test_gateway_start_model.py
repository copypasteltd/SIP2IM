"""Offline request-state model and source checks; not an Android runtime test."""
from pathlib import Path
from threading import Event, Lock, Thread
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / 'android/app/src/main/kotlin/io/voipgw/gateway/core'
UI = CORE.parent / 'ui/MainActivity.kt'

class Model:
    def __init__(self):
        self.state = 'unknown'
        self.lock = Lock()
        self.calls = 0
    def request(self, bound, retry=False, accepted=False, entered=None, release=None):
        if not bound: return
        with self.lock:
            if self.state not in (('failed', 'accepted') if retry else ('unknown',)): return
            self.state = 'requesting'
        self.calls += 1
        if entered: entered.set()
        if release: release.wait(2)
        with self.lock: self.state = 'accepted' if accepted else 'failed'

class GatewayStartTest(unittest.TestCase):
    def test_recreation_never_retries_failure_and_user_retry_is_bound_only(self):
        m = Model(); m.request(True); self.assertEqual(m.state, 'failed')
        m.request(True); m.request(False, retry=True, accepted=True)
        self.assertEqual((m.calls, m.state), (1, 'failed'))
        m.request(True, retry=True, accepted=True)
        self.assertEqual((m.calls, m.state), (2, 'accepted'))
        m.request(True); self.assertEqual(m.calls, 2)
        m.request(False, retry=True); self.assertEqual((m.calls, m.state), (2, 'accepted'))
        m.request(True, retry=True); self.assertEqual((m.calls, m.state), (3, 'failed'))
        m.request(True); self.assertEqual((m.calls, m.state), (3, 'failed'))
    def test_explicit_retry_rejects_unknown(self):
        m = Model(); m.request(True, retry=True, accepted=True)
        self.assertEqual((m.calls, m.state), (0, 'unknown'))
    def test_inflight_attempt_excludes_all_other_attempts(self):
        m = Model(); entered, release = Event(), Event()
        thread = Thread(target=lambda: m.request(True, entered=entered, release=release))
        thread.start(); self.assertTrue(entered.wait(2))
        m.request(True, retry=True, accepted=True); m.request(True, accepted=True)
        self.assertEqual(m.calls, 1); release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(m.state, 'failed')
        m.request(True, retry=True, accepted=True); self.assertEqual(m.state, 'accepted')
        entered.clear(); release.clear()
        thread = Thread(target=lambda: m.request(True, retry=True, accepted=True, entered=entered, release=release))
        thread.start(); self.assertTrue(entered.wait(2))
        m.request(True, retry=True); m.request(True)
        self.assertEqual(m.calls, 3); release.set(); thread.join(2)
        self.assertFalse(thread.is_alive()); self.assertEqual(m.state, 'accepted')
    def test_retry_visibility_tracks_connection_and_preserves_gates(self):
        def visible(bound, start, connection):
            return bound and connection != 'terminal' and start in ('failed', 'accepted')

        for start in ('failed', 'accepted'):
            with self.subTest(start=start):
                self.assertTrue(visible(True, start, 'unknown'))
                self.assertFalse(visible(True, start, 'terminal'))
                self.assertTrue(visible(True, start, 'unknown'))
                self.assertFalse(visible(False, start, 'unknown'))
        for start in ('unknown', 'requesting'):
            for connection in ('unknown', 'terminal'):
                self.assertFalse(visible(True, start, connection))

    def test_wiring_and_locales(self):
        start = (CORE / 'GatewayStart.kt').read_text(encoding='utf-8')
        activity = UI.read_text(encoding='utf-8')
        boot = (CORE / 'BootReceiver.kt').read_text(encoding='utf-8')
        self.assertLess(start.index('if (Credentials(app).state() != BindingFence.State.BOUND) return'),
                        start.index('state = State.REQUESTING'))
        self.assertLess(boot.index('if (Credentials(context).state() != BindingFence.State.BOUND) return'),
                        boot.index('context.startForegroundService(service)'))
        self.assertIn('state != State.FAILED && state != State.ACCEPTED else state != State.UNKNOWN', start)
        self.assertIn('GatewayService.ACTION_INITIAL_BIND', start)
        self.assertNotIn('terminal =', start)
        self.assertIn('val copy = synchronized(this) { observers.toList() }', start)
        self.assertLess(activity.index('GatewayStart.register(it)'), activity.index('        refreshStart()'))
        self.assertIn('GatewayStart.unregister(it)', activity)
        self.assertIn('val bound = credentials.state() == BindingFence.State.BOUND', activity)
        self.assertIn('GatewayConnectionObservation.state.current() != TerminalConnectionObservation.State.TERMINAL_CLOSED', activity)
        self.assertIn('(state == GatewayStart.State.FAILED || state == GatewayStart.State.ACCEPTED)', activity)
        self.assertIn('mainHandler.post { refreshConnection(); refreshStart() }', activity)
        self.assertIn('if (credentials.state() == BindingFence.State.BOUND) GatewayStart.request(applicationContext)', activity)
        self.assertIn('retry = true', activity)
        for locale in ('values', 'values-en', 'values-zh-rHK'):
            root = ET.parse(ROOT / 'android/app/src/main/res' / locale / 'strings.xml').getroot()
            strings = {x.attrib['name']: x.text for x in root}
            self.assertTrue({'gateway_retry', 'gateway_start_unknown', 'gateway_start_requesting', 'gateway_start_requested', 'gateway_start_failed'} <= strings.keys())
            self.assertEqual(strings['gateway_retry'], {'values': '再次请求启动网关', 'values-en': 'Request gateway start again', 'values-zh-rHK': '再次要求啟動網關'}[locale])
            self.assertEqual(strings['gateway_start_requested'], {'values': '已向系统请求启动网关；这不表示网关正在运行或在线。', 'values-en': 'Gateway start requested from Android; this does not mean it is running or online.', 'values-zh-rHK': '已向系統要求啟動網關；這不代表網關正在運行或在線。'}[locale])

if __name__ == '__main__': unittest.main()
