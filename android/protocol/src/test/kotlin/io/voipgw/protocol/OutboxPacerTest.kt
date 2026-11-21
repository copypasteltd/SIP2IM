package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class OutboxPacerTest {
    @Test fun onlyMatchingPositiveAckAdvances() {
        val pacer = OutboxPacer(); val generation = pacer.generation()
        assertTrue(pacer.sent(generation, "first"))
        assertFalse(pacer.acknowledged(generation, "other", true) {}); assertFalse(pacer.acknowledged(generation, "first", false) {})
        assertEquals("first", pacer.inFlight)
        try { pacer.acknowledged(generation, "first", true) { error("delete failed") }; fail() } catch (_: IllegalStateException) {}
        assertEquals("first", pacer.inFlight)
        var deleted = false
        assertTrue(pacer.acknowledged(generation, "first", true) { deleted = true }); assertTrue(deleted); assertNull(pacer.inFlight)
    }

    @Test fun staleSendCompletionCannotOccupyNewConnection() {
        val pacer = OutboxPacer(); val old = pacer.generation()
        pacer.reset()
        val current = pacer.generation()
        assertFalse(pacer.sent(old, "old"))
        assertTrue(pacer.sent(current, "new"))
        assertFalse(pacer.sent(old, "old"))
        assertEquals("new", pacer.inFlight)
        assertFalse(pacer.isInFlight(old, "new"))
    }

    @Test fun resetDoesNotWaitForDeleteAndOldAckCannotClearNewFlight() {
        val pacer = OutboxPacer(); val old = pacer.generation()
        assertTrue(pacer.sent(old, "event"))
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        var advanced = true
        val worker = Thread { advanced = pacer.acknowledged(old, "event", true) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) } }
        worker.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            pacer.reset()
            val current = pacer.generation()
            assertTrue(pacer.sent(current, "event"))
        } finally { release.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive)
        assertFalse(advanced)
        assertEquals("event", pacer.inFlight)
    }
}
