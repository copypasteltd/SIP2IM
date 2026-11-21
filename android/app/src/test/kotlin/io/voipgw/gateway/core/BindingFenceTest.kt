package io.voipgw.gateway.core

import java.util.ArrayDeque
import org.junit.Assert.*
import org.junit.Test

class BindingFenceTest {
    private class SavedBinding : BindingStore {
        enum class Fault { NONE, BEFORE_WRITE, AFTER_WRITE }

        var record: BindingRecord? = BindingRecord(BindingRecord.Phase.UNBOUND)
        var nextFault = Fault.NONE
        private var ids = 0

        override fun read() = record
        override fun replace(expected: BindingRecord, next: BindingRecord): Boolean {
            val current = record
            if (!expected.matches(current)) return false
            val fault = nextFault.also { nextFault = Fault.NONE }
            if (fault == Fault.BEFORE_WRITE) error("Write rolled back")
            record = next
            if (fault == Fault.AFTER_WRITE) error("Commit acknowledgement lost")
            return true
        }

        fun reopen(legacy: Boolean = false) = BindingFence(this, { legacy }) { "local-" + ++ids }
        fun bind(): BindingFence {
            val id = "committed-v1"
            val identity = BoundIdentity(id, DEVICE, "fixture-credential", "http://offline.invalid")
            record = BindingRecord(BindingRecord.Phase.IDLE, id, identity)
            return reopen()
        }
    }

    @Test fun legacyPreferencesAndLegacyDatabasesCannotBeAdopted() {
        val disk = SavedBinding()
        assertEquals(BindingFence.State.UNBOUND, disk.reopen().state())
        val legacy = disk.reopen(legacy = true)
        assertEquals(BindingFence.State.RECONCILIATION, legacy.state())
        assertNull(legacy.beginBinding(bindingFixture()))
        assertNull(legacy.openConnection())
        disk.record = BindingRecord(BindingRecord.Phase.LEGACY)
        assertEquals(BindingFence.State.RECONCILIATION, disk.reopen().state())
        assertNull(disk.reopen().beginBinding(bindingFixture()))
        disk.record = null
        assertEquals(BindingFence.State.RECONCILIATION, disk.reopen().state())
        assertNull(disk.reopen().beginBinding(bindingFixture()))
    }

    @Test fun legacyPendingStaysOperatorControlledWithoutWireEvidence() {
        val disk = SavedBinding().apply { record = BindingRecord(BindingRecord.Phase.PENDING, "legacy-pending") }
        val restarted = disk.reopen()
        assertEquals(BindingFence.State.RECONCILIATION, restarted.state())
        assertNull(restarted.pendingBinding())
        assertNull(restarted.beginBinding(bindingFixture()))
        assertNull(restarted.openConnection())
    }

    @Test fun observedTerminalFenceSurvivesProcessAndServiceRecreation() {
        for (code in listOf(4003, 4005, 4010, 4011)) {
            val disk = SavedBinding()
            val fence = disk.bind()
            val execution = GatewayExecution(fence)
            val connection = checkNotNull(execution.open())
            assertEquals(GatewayExecution.Hello.ACCEPTED, execution.hello(connection, DEVICE) {})
            connection.observeDisconnect(checkNotNull(GatewayExecution.terminalReason(code)))
            assertNull(execution.runReady<Unit>(connection, { false }) { error("Executed after terminal close") })
            assertTrue(execution.close(connection))
            for (recreated in listOf(fence, disk.reopen())) {
                assertEquals(BindingFence.State.TERMINAL, recreated.state())
                assertNull(recreated.beginBinding(bindingFixture()))
                assertNull(GatewayExecution(recreated).open())
            }
            assertEquals("ws:$code", disk.record?.reason)
        }
    }

    @Test fun uncertainTerminalWriteCannotTurnIntoAnIdleBindingOnRestart() {
        for (fault in listOf(SavedBinding.Fault.BEFORE_WRITE, SavedBinding.Fault.AFTER_WRITE)) {
            val disk = SavedBinding()
            val fence = disk.bind()
            val execution = GatewayExecution(fence)
            val connection = checkNotNull(execution.open())
            connection.observeDisconnect("ws:4010")
            disk.nextFault = fault
            assertFalse(execution.close(connection))
            assertEquals(BindingFence.State.TERMINAL, fence.state())
            val restarted = disk.reopen()
            assertEquals(
                if (fault == SavedBinding.Fault.BEFORE_WRITE) BindingFence.State.RECONCILIATION else BindingFence.State.TERMINAL,
                restarted.state()
            )
            assertNull(restarted.openConnection())
            assertNull(restarted.beginBinding(bindingFixture()))
        }
    }

    @Test fun orphanedOpenCannotReconnectButObservedTransportLossCan() {
        val disk = SavedBinding()
        val fence = disk.bind()
        val execution = GatewayExecution(fence)
        val first = checkNotNull(execution.open())
        val orphan = disk.reopen()
        assertEquals(BindingFence.State.RECONCILIATION, orphan.state())
        assertNull(orphan.openConnection())
        for (code in listOf(1000, 1001, 4001, 4009)) assertNull(GatewayExecution.terminalReason(code))
        first.observeDisconnect()
        assertTrue(execution.close(first))
        val restarted = GatewayExecution(disk.reopen())
        val second = checkNotNull(restarted.open())
        assertEquals(first.identity.id, second.identity.id)
        assertNotEquals(first.generation, second.generation)
        first.observeDisconnect("ws:4010")
        assertFalse(execution.close(first))
        assertEquals(GatewayExecution.Hello.STALE, restarted.hello(first, DEVICE) { error("Stale hello configured") })
        assertNull(restarted.runReady<Unit>(second, { false }) { error("Executed before hello") })
        assertEquals(GatewayExecution.Hello.ACCEPTED, restarted.hello(second, DEVICE) {})
        assertEquals(1, restarted.runReady(second, { false }) { 1 })
    }

    private class WaitingConnection(private val execution: GatewayExecution, private val connection: BindingConnection) {
        private var elapsed = 40L
        private var wake: Runnable? = null
        var released: Boolean? = null
            private set
        private val deadline = HelloDeadline(
            now = { elapsed },
            postDelayed = { task, delay -> assertEquals(10_000L, delay); wake = task; true },
            removeCallbacks = { if (wake === it) wake = null },
            withCurrent = { task -> if (released == null) task() },
            onExpired = {
                connection.observeDisconnect()
                released = execution.close(connection)
            },
        )
        init { assertTrue(deadline.arm()) }

        fun expire() {
            elapsed += 10_000L
            checkNotNull(wake).run()
            assertFalse(deadline.allowsReply())
        }
    }

    @Test fun handshakeTimeoutAllowsANewGenerationOnlyAfterTheOriginalBindingIsReleased() {
        val disk = SavedBinding()
        val execution = GatewayExecution(disk.bind())
        val original = checkNotNull(execution.open())
        val waiting = WaitingConnection(execution, original)
        assertEquals(BindingRecord.Phase.OPEN, disk.record?.phase)
        assertNull(execution.open())
        waiting.expire()
        assertEquals(true, waiting.released)
        assertEquals(BindingRecord.Phase.IDLE, disk.record?.phase)
        val replacement = checkNotNull(execution.open())
        assertEquals(original.identity.id, replacement.identity.id)
        assertNotEquals(original.generation, replacement.generation)
        assertEquals(GatewayExecution.Hello.STALE, execution.hello(original, DEVICE) { error("Old socket configured") })
        assertFalse(execution.close(original))
        assertFalse(execution.isReady(replacement))
        assertEquals(GatewayExecution.Hello.ACCEPTED, execution.hello(replacement, DEVICE) {})
    }

    @Test fun handshakeTimeoutPreservesAnAlreadyObservedTerminalClose() {
        val disk = SavedBinding()
        val fence = disk.bind()
        val execution = GatewayExecution(fence)
        val original = checkNotNull(execution.open())
        val waiting = WaitingConnection(execution, original)
        original.observeDisconnect(checkNotNull(GatewayExecution.terminalReason(4010)))
        waiting.expire()
        assertEquals(true, waiting.released)
        assertEquals(BindingFence.State.TERMINAL, fence.state())
        assertEquals(BindingFence.State.TERMINAL, disk.reopen().state())
        assertNull(execution.open())
    }

    @Test fun handshakeTimeoutDoesNotAcquireAnotherGenerationAfterAnUncertainClose() {
        for (fault in listOf(SavedBinding.Fault.BEFORE_WRITE, SavedBinding.Fault.AFTER_WRITE)) {
            val disk = SavedBinding()
            val fence = disk.bind()
            val execution = GatewayExecution(fence)
            val original = checkNotNull(execution.open())
            val waiting = WaitingConnection(execution, original)
            disk.nextFault = fault
            waiting.expire()
            assertEquals(false, waiting.released)
            assertEquals(BindingFence.State.RECONCILIATION, fence.state())
            assertNull(execution.open())
        }
    }

    @Test fun mismatchingAbsentAndCoercedIdentityNeverApplyConfigOrPermitEffects() {
        for (deviceId in listOf("different", "", null, 123)) {
            val disk = SavedBinding()
            val execution = GatewayExecution(disk.bind())
            val connection = checkNotNull(execution.open())
            assertEquals(GatewayExecution.Hello.IDENTITY_MISMATCH, execution.hello(connection, deviceId) { error("Applied mismatched config") })
            assertNull(execution.runReady<Unit>(connection, { false }) { error("Executed without matching identity") })
            assertTrue(execution.close(connection))
            assertEquals(BindingFence.State.TERMINAL, disk.reopen().state())
        }
    }

    @Test fun configMustSucceedAndDuplicateHelloCannotReconfigure() {
        val execution = GatewayExecution(SavedBinding().bind())
        val connection = checkNotNull(execution.open())
        assertThrows(IllegalStateException::class.java) { execution.hello(connection, DEVICE) { error("Config commit failed") } }
        assertFalse(execution.isReady(connection))
        assertEquals(GatewayExecution.Hello.ACCEPTED, execution.hello(connection, DEVICE) {})
        assertEquals(GatewayExecution.Hello.DUPLICATE, execution.hello(connection, DEVICE) { error("Reconfigured") })
        assertEquals(GatewayExecution.Hello.IDENTITY_MISMATCH, execution.hello(connection, "different") { error("Reconfigured") })
        assertFalse(execution.isReady(connection))
    }

    @Test fun pauseOrDisconnectBetweenClaimAndSubmitFencesTheSend() {
        val execution = GatewayExecution(SavedBinding().bind())
        val connection = checkNotNull(execution.open())
        assertEquals(GatewayExecution.Hello.ACCEPTED, execution.hello(connection, DEVICE) {})
        var paused = false
        var claims = 0
        var sends = 0
        assertEquals(1, execution.runReady(connection, { paused }) { ++claims })
        paused = true
        assertNull(execution.runReady(connection, { paused }) { ++sends })
        assertTrue(execution.isReady(connection))
        paused = false
        assertNull(execution.runReady(connection, {
            connection.observeDisconnect("ws:4011")
            paused
        }) { ++sends })
        assertEquals(1, claims)
        assertEquals(0, sends)
    }

    @Test fun aCachedReadyGenerationCannotExecuteAfterItsLocalBindingChanges() {
        val disk = SavedBinding()
        val fence = disk.bind()
        val execution = GatewayExecution(fence)
        val active = checkNotNull(execution.open())
        assertEquals(GatewayExecution.Hello.ACCEPTED, execution.hello(active, DEVICE) {})
        val original = checkNotNull(disk.record)
        val identity = active.identity
        disk.record = BindingRecord(original.phase, original.id,
            BoundIdentity(identity.id, identity.deviceId, "different-credential", identity.origin), original.generation)
        var ran = false
        assertNull(execution.runReady(active, { false }) { ran = true })
        assertFalse(ran)
        assertEquals(BindingFence.State.RECONCILIATION, fence.state())
        assertFalse(execution.close(active))
        assertEquals(BindingFence.State.RECONCILIATION, disk.reopen().state())
    }

    @Test fun terminalObservationWinsOverTransportLossBeforeRetirement() {
        val disk = SavedBinding()
        val fence = disk.bind()
        val execution = GatewayExecution(fence)
        val active = checkNotNull(execution.open())
        active.observeDisconnect()
        active.observeDisconnect("ws:4010")
        assertEquals(BindingFence.State.TERMINAL, fence.state())
        assertTrue(execution.close(active))
        assertEquals(BindingFence.State.TERMINAL, disk.reopen().state())
    }

    @Test fun bufferedDrainCannotBorrowTheNextConnectionsReadiness() {
        val execution = GatewayExecution(SavedBinding().bind())
        val loop = ArrayDeque<Runnable>()
        val seen = mutableListOf<Long>()
        fun drain(connection: BindingConnection, row: Long) = CooperativeDrain<Long>(
            post = { loop.addLast(it) }, stopped = { !execution.isReady(connection) }, paused = { false },
            boundary = { row }, page = { after, _ -> if (after == null) listOf(row) else emptyList() },
            key = { it }, process = { value -> execution.runReady(connection, { false }) { seen.add(value) } }
        )
        val first = checkNotNull(execution.open())
        execution.hello(first, DEVICE) {}
        drain(first, 1).wake()
        repeat(2) { loop.removeFirst().run() }
        first.observeDisconnect()
        assertTrue(execution.close(first))
        val second = checkNotNull(execution.open())
        execution.hello(second, DEVICE) {}
        drain(second, 2).wake()
        while (loop.isNotEmpty()) loop.removeFirst().run()
        assertEquals(listOf(2L), seen)
    }

    private companion object { const val DEVICE = "dev_fixture" }
}
