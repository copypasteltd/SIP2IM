"""Source-level regressions; these do not execute Android lifecycle or telephony."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / "android/app/src/main/kotlin/io/voipgw/gateway/core/GatewayService.kt"
STORE = ROOT / "android/app/src/main/kotlin/io/voipgw/gateway/sms/SmsTaskStore.kt"

class GatewayPauseSourceTest(unittest.TestCase):
    def test_pause_and_live_authority_are_rechecked_at_claim_and_submission(self):
        source = SERVICE.read_text(encoding="utf-8")
        sender = STORE.with_name("SmsSender.kt").read_text(encoding="utf-8")
        sms = source.partition('private fun processSms(')[2].partition('private fun withCurrentSocket(')[0]
        self.assertIn('if (!execution.isReady(active.connection) || locallyPaused()) return', sms)
        self.assertIn('SimReadiness.State.UNKNOWN -> return', sms)
        self.assertIn('claim = { count -> claimSms(active, task, count) }', sms)
        self.assertIn('dispatch = { send -> withSmsAuthority(active, send) != null }', sms)
        self.assertIn('execution.runReady(active.connection, ::locallyPaused) { smsStore.claimWithParts(active.connection, task, count) }', sms)
        self.assertIn('if (stopped || session !== active || socket == null) null', sms)
        self.assertIn('else execution.runReady(active.connection, ::locallyPaused, block)', sms)
        self.assertNotIn('"DEVICE_DISABLED"', sms)  # Pause holds the queue instead of failing it.
        self.assertIn('SmsSender.Result.NOT_SUBMITTED, SmsSender.Result.SUBMITTED, SmsSender.Result.UNKNOWN -> return', sms)
        self.assertLess(sender.index('try { claim(parts.size) } catch (_: Exception) { return Result.UNKNOWN }'),
                        sender.index('if (!claimed) return Result.NOT_SUBMITTED'))
        self.assertLess(sender.index('if (!claimed) return Result.NOT_SUBMITTED'),
                        sender.index('dispatch { manager.sendMultipartTextMessage('))
        self.assertEqual(sender.count('sendMultipartTextMessage('), 1)

    def test_cooperative_controller_is_scoped_to_current_session_and_yields(self):
        source = SERVICE.read_text(encoding="utf-8")
        controller = (SERVICE.parent / "CooperativeDrain.kt").read_text(encoding="utf-8")
        session = source.partition('private inner class Session(')[2].partition('private val outboxWake')[0]
        for link in ('stopped = { stopped || !execution.isReady(connection) }',
                     'paused = ::locallyPaused', 'boundary = { smsStore.queueBoundary(connection) }',
                     'smsStore.queuePage(connection, after, boundary, 32)', 'processSms(this, row.taskId, row.payload)'):
            self.assertIn(link, session)
        handle = source.partition('private fun handleSms(')[2].partition('private fun locallyPaused(')[0]
        reservation = handle.index('smsStore.reserve(active.connection, id, task, canonical, error) ?: return')
        ack = handle.index('check(sendOn(ws, "ack", response))')
        wake_after_ack = handle.index('if (ack.newlyReserved) handler.post { lifecycle.run { active.drain.wake() } }')
        self.assertLess(reservation, ack)
        self.assertLess(ack, wake_after_ack)
        wake = controller.partition('fun wake()')[2].partition('private fun step()')[0]
        self.assertIn('if (stopped()) return', wake)
        self.assertIn('if (active) { wakePending = true; return }', wake)
        process = controller.index('process(entry)')
        self.assertLess(process, controller.index('post(Runnable { step() })', process))
        self.assertIn('if (stopped() || paused()) { finish(false); return }', controller)
        self.assertIn('entries = null', controller)
        self.assertIn('handler.removeCallbacksAndMessages(null)', source)

    def test_pause_wakes_heartbeat_and_listener_is_removed(self):
        source = SERVICE.read_text(encoding="utf-8")
        self.assertIn('if (key == "paused") rescheduleHeartbeat()', source)
        self.assertIn('registerOnSharedPreferenceChangeListener(pauseListener)', source)
        self.assertIn('unregisterOnSharedPreferenceChangeListener(pauseListener)', source)
        heartbeat = source.partition('private val heartbeat =')[2].partition('override fun onCreate()')[0]
        self.assertIn('if (stopped || terminal) return@heartbeatWork', heartbeat)
        # Heartbeat and outbound delivery of inbound events do not stop on local pause.
        self.assertIn('execution.runReady(active.connection, { false })', heartbeat)
        self.assertLess(heartbeat.index('flushNext(active, ws)'), heartbeat.index('HeartbeatObservation.payload'))
        self.assertLess(heartbeat.index('HeartbeatObservation.payload'), heartbeat.index('active.drain.wake()'))

    def test_hello_checks_identity_and_marks_ready_before_scheduling_heartbeat(self):
        source = SERVICE.read_text(encoding="utf-8")
        fence = (SERVICE.parent / 'BindingFence.kt').read_text(encoding="utf-8")
        hello = source.partition('private fun handleHello(')[2].partition('private fun refreshStatus(')[0]
        self.assertIn('execution.hello(active.connection, payload?.opt("deviceId"))', hello)
        self.assertLess(hello.index('refreshStatus(ws)'), hello.index('GatewayExecution.Hello.ACCEPTED ->'))
        self.assertLess(hello.index('GatewayExecution.Hello.ACCEPTED ->'), hello.index('rescheduleHeartbeat()'))
        self.assertIn('GatewayExecution.Hello.IDENTITY_MISMATCH, GatewayExecution.Hello.STALE -> cancelConnection(active, ws)', hello)
        decision = fence.partition('fun hello(')[2].partition('fun isReady(')[0]
        ordered = ('deviceId !is String || deviceId != connection.identity.deviceId', 'if (!fence.owns(connection))',
                   'configure()', 'if (connection.disconnected)', 'ready = true')
        positions = [decision.index(step) for step in ordered]
        self.assertEqual(positions, sorted(positions))
        self.assertIn('!fence.owns(connection) || paused() || !isReady(connection)', fence)
        snapshot = source.partition('private fun refreshStatus(')[2].partition('private fun handleProbe(')[0]
        self.assertIn('SimSnapshot.observe(this) ?: return false', snapshot)
        self.assertIn('check(ws.send(frame.toString()))', snapshot)

    def test_only_queued_tasks_of_current_open_scope_are_claimed_or_failed(self):
        source = STORE.read_text(encoding="utf-8")
        self.assertIn('phase = \'OPEN\' AND binding_id = ? AND connection_id = ?', source)
        self.assertIn('private val queueScope = "binding_id = ? AND connection_id = ? AND state = ?"', source)
        self.assertIn('arrayOf(connection.identity.id, connection.generation, "queued")', source)
        self.assertIn('"$queueScope AND rowid > ? AND rowid <= ?"', source)
        for method, following in (('failQueued', 'claimWithParts'), ('claimWithParts', 'wakeOutbox')):
            with self.subTest(method=method):
                body = source.partition(f'fun {method}(')[2].partition(f'fun {following}(')[0]
                self.assertLess(body.index('if (!isOpen(db, connection))'), body.index('db.update("sms_task"'))
                self.assertIn('"$queueScope AND task_id = ?", queueArgs(connection) + taskId', body)
                self.assertIn('insertResult(db, payload, now, connection.identity.id)', body)
        claim = source.partition('fun claimWithParts(')[2].partition('private fun wakeOutbox(')[0]
        self.assertLess(claim.index('put("state", "unknown")'), claim.index('insertResult('))
        self.assertLess(claim.index('insertResult('), claim.index('db.setTransactionSuccessful()'))
        self.assertLess(claim.index('db.endTransaction()'), claim.index('if (claimed) wakeOutbox()'))


if __name__ == "__main__":
    unittest.main()
