"""Offline connection model and source checks; not an Android runtime test."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt"
ACTIVITY = ROOT / "android/app/src/main/kotlin/io/voipgw/gateway/ui/MainActivity.kt"
TERMINAL = {4003, 4005, 4010, 4011}

class Model:
    """Contract-level model of one service with a shared durable binding marker."""
    def __init__(self, disk=None):
        self.disk = {'phase': 'UNBOUND'} if disk is None else disk
        self.socket = None
        self.inflight = None
        self.ready = False
        self.stopped = False
        self.terminal = False
        self.attempted = False
        self.ticket = 0
        self.used = []

    def bind(self, device):
        self.disk.update(phase='IDLE', device=device)

    def start(self):
        if not self.stopped and not self.terminal and not self.attempted and self.disk['phase'] == 'IDLE':
            self.connect()

    def connect(self):
        if self.stopped or self.terminal or self.socket is not None or self.disk['phase'] != 'IDLE':
            return
        self.attempted = True
        self.socket = object()
        self.disk.update(phase='OPEN', owner=self.socket)
        self.used.append(self.disk['device'])

    def hello(self, sock, device):
        if self.stopped or sock is not self.socket or self.disk.get('owner') is not sock:
            return False
        if device != self.disk['device']:
            self.finish(sock, 4003)
            return False
        self.ready = True
        return True

    def finish(self, sock, code):
        if self.stopped or sock is not self.socket or self.disk.get('owner') is not sock:
            return None
        self.socket = self.inflight = None
        self.ready = False
        self.terminal = code in TERMINAL
        self.disk.update(phase='TERMINAL' if self.terminal else 'IDLE', owner=None)
        self.ticket += 1
        return None if self.terminal else self.ticket

    def timer(self, ticket):
        if not self.stopped and not self.terminal and ticket == self.ticket:
            self.connect()

    def stop(self):
        if self.socket is not None:
            self.finish(self.socket, 1006)
        self.stopped = True


class GatewayConnectionTest(unittest.TestCase):
    def model(self):
        m = Model(); m.bind('device'); m.start()
        self.assertTrue(m.hello(m.socket, 'device')); m.inflight = 'event'
        return m

    def test_terminal_is_durable_and_stale_callback_cannot_reopen(self):
        for code in TERMINAL:
            with self.subTest(code=code):
                m = self.model(); old = m.socket
                self.assertIsNone(m.finish(old, code))
                self.assertEqual((m.socket, m.ready, m.inflight), (None, False, None))
                m.finish(old, 1006); m.start()
                restarted = Model(m.disk); restarted.start()
                self.assertEqual(m.disk['phase'], 'TERMINAL')
                self.assertIsNone(m.socket); self.assertIsNone(restarted.socket)
                self.assertEqual(m.used, ['device'])

    def test_initial_binding_starts_once_and_unowned_open_cannot_be_resumed(self):
        m = Model(); m.start(); self.assertIsNone(m.socket)
        m.bind('new'); m.start(); current = m.socket
        self.assertIsNotNone(current); self.assertEqual(m.used, ['new'])
        self.assertFalse(m.ready)
        restarted = Model(m.disk); restarted.start()
        self.assertIsNone(restarted.socket); self.assertEqual(m.disk['phase'], 'OPEN')
        m.start(); self.assertIs(m.socket, current)
        m.finish(current, 4010); m.start(); self.assertIsNone(m.socket)
        self.assertEqual(m.used, ['new'])

    def test_start_request_cannot_bypass_reconnect_backoff(self):
        m = self.model(); old = m.socket; ticket = m.finish(old, 1006)
        m.start(); self.assertIsNone(m.socket)
        self.assertEqual(m.ticket, ticket)
        m.timer(ticket); self.assertIsNotNone(m.socket); self.assertIsNot(m.socket, old)
        self.assertFalse(m.ready); self.assertEqual(m.used, ['device', 'device'])

    def test_stale_close_and_hello_cannot_affect_new_socket(self):
        m = self.model(); old = m.socket; ticket = m.finish(old, 1006); m.timer(ticket)
        new = m.socket; m.finish(old, 4010)
        self.assertFalse(m.hello(old, 'wrong'))
        self.assertIs(m.socket, new); self.assertFalse(m.terminal); self.assertFalse(m.ready)
        self.assertTrue(m.hello(new, 'device'))

    def test_missing_or_mismatched_hello_leaves_durable_block(self):
        for device in (None, 'different', 1):
            with self.subTest(device=device):
                m = self.model()
                self.assertFalse(m.hello(m.socket, device))
                self.assertEqual(m.disk['phase'], 'TERMINAL')
                self.assertFalse(m.ready)

    def test_old_retry_timer_cannot_override_terminal(self):
        m = self.model(); ticket = m.finish(m.socket, 1006)
        m.timer(ticket); new = m.socket
        m.finish(new, 4010); m.timer(ticket)
        self.assertIsNone(m.socket); self.assertEqual(m.used, ['device', 'device'])

    def test_stopped_work_cannot_reconnect_but_clean_new_service_can(self):
        m = self.model(); ticket = m.finish(m.socket, 1006); m.stop()
        m.timer(ticket); m.start()
        self.assertIsNone(m.socket)
        restarted = Model(m.disk); restarted.start()
        self.assertIsNotNone(restarted.socket); self.assertFalse(restarted.ready)

    def test_service_wiring(self):
        source = SERVICE.read_text(encoding='utf-8')
        fence = (SERVICE.parent / 'BindingFence.kt').read_text(encoding='utf-8')
        self.assertIn('4003, 4005, 4010, 4011 -> "ws:$code"', fence)
        listener = source.partition('private fun listener(')[2].partition('private fun handleHello(')[0]
        callback = listener.partition('private fun current(')[2].partition('override fun onOpen')[0]
        self.assertIn('synchronized(connectionLock)', callback)
        self.assertIn('session === active && socket === ws', callback)
        self.assertNotIn('handler.post', callback)
        for method in ('onClosed', 'onClosing'):
            block = listener.partition(f'override fun {method}(')[2].partition('override fun ')[0]
            self.assertLess(block.index('observeDisconnect(GatewayExecution.terminalReason(code))'),
                            block.index('current(webSocket) { finishConnection(active) }'))
        close = source.partition('private fun finishConnection(')[2].partition('private fun acknowledgeAndFlush(')[0]
        self.assertLess(close.index('if (stopped || session !== active) return'), close.index('execution.close(active.connection)'))
        self.assertIn('session = null; socket = null; pacer.reset()', close)
        self.assertIn('if (active.connection.terminalReason != null || !released)', close)
        self.assertIn('if (!stopped && !terminal && ticket == reconnectTicket) connect()', close)
        self.assertLess(close.index('stopSelf()'), close.index('handler.postDelayed('))
        self.assertIn('if (!connectionAttempted && session == null) connect()', source)
        self.assertIn('connectionAttempted = true', source)
        self.assertIn('connection.observeDisconnect("hello.identity")', fence)
        self.assertIn('if (current.phase != BindingRecord.Phase.IDLE) return@checked null', fence)
        activity = ACTIVITY.read_text(encoding='utf-8')
        self.assertIn('if (result == BindingReplay.Result.SUCCESS) GatewayStart.request(app)', activity)
        start = (SERVICE.parent / 'GatewayStart.kt').read_text(encoding='utf-8')
        self.assertIn('Intent(app, GatewayService::class.java).setAction(GatewayService.ACTION_INITIAL_BIND)', start)
        self.assertIn('catch (_: RuntimeException)', start)


if __name__ == '__main__': unittest.main()
