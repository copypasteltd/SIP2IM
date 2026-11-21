"""Offline source checks; not an Android runtime test."""
from pathlib import Path
import unittest

SERVICE = Path(__file__).resolve().parents[1] / 'android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt'

class OutboxWatchdogSourceTest(unittest.TestCase):
    def test_watchdog_precedes_attempt_and_failures_cancel(self):
        source = SERVICE.read_text(encoding='utf-8')
        flush = source.partition('private fun flushNext(')[2].partition('private fun envelope(')[0]
        ordered = ('execution.runReady(active.connection', 'if (pacer.inFlight != null)',
                   'outbox.pendingHead(active.bindingId)', 'if (!execution.isReady(active.connection))',
                   'check(ws.send(frame.toString()))', 'pacer.sent(generation, event.id)',
                   'handler.postDelayed(', 'check(scheduled)', 'outbox.attempted(active.bindingId, event.id)')
        positions = [flush.index(step) for step in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertEqual(flush.count('handler.postDelayed('), 1)
        self.assertIn('if (!stopped && session === active && pacer.isInFlight(generation, event.id)) cancelConnection(active, ws)', flush)
        self.assertIn('catch (_: Exception) { cancelConnection(active, ws) }', flush)
        self.assertNotIn('outbox.acknowledge', flush)
        cancel = source.partition('private fun cancelConnection(')[2].partition('private fun finishConnection(')[0]
        self.assertLess(cancel.index('active.connection.observeDisconnect()'), cancel.index('ws.cancel()'))

    def test_positive_matching_ack_deletes_only_for_current_binding(self):
        source = SERVICE.read_text(encoding='utf-8')
        listener = source.partition('override fun onMessage(')[2].partition('override fun onFailure(')[0]
        self.assertLess(listener.index('execution.runReady(active.connection'), listener.index('acknowledgeAndFlush(active, webSocket, ref, ok)'))
        ack = source.partition('private fun acknowledgeAndFlush(')[2].partition('private fun flushNext(')[0]
        self.assertIn('if (pacer.acknowledged(pacer.generation(), ref, ok) { outbox.acknowledge(active.bindingId, ref) }) flushNext(active, ws)', ack)

if __name__ == '__main__': unittest.main()
