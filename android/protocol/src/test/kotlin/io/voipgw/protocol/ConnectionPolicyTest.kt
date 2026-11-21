package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class ConnectionPolicyTest {
    @Test fun backoffAndHandshakeOrder() {
        val policy = ConnectionPolicy()
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), (0..6).map { policy.disconnected() })
        policy.connected()
        val order = mutableListOf<String>()
        policy.helloAccepted({ order.add("snapshot") }, { order.add("outbox") })
        assertEquals(listOf("snapshot", "outbox"), order)
        assertEquals(ConnectionPolicy.Phase.READY, policy.phase)
        assertEquals(1000L, policy.disconnected())
    }
    @Test fun snapshotFailureDoesNotFlush() {
        val policy = ConnectionPolicy(); policy.connected()
        var flushed = false
        try { policy.helloAccepted({ error("failed") }, { flushed = true }); fail() } catch (_: IllegalStateException) { }
        assertFalse(flushed)
        assertEquals(ConnectionPolicy.Phase.AWAITING_HELLO, policy.phase)
    }
}
