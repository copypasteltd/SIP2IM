package io.voipgw.gateway.core

import io.voipgw.protocol.OutboxPacer
import org.junit.Assert.*
import org.junit.Test

class OutboxReconnectBackoffTest {
    private data class Flight(val connection: BindingConnection, val generation: Long, val eventId: String)

    private class Harness {
        val pacer = OutboxPacer()
        val backoff = OutboxReconnectBackoff(pacer)

        fun attach(bindingId: String = "binding-a", eventId: String = "head"): Flight {
            val generation = pacer.generation()
            val connection = BindingConnection(
                BoundIdentity(bindingId, "fixture-device", "fixture-credential", "http://offline.invalid"),
                "attachment-$generation",
            )
            backoff.helloAccepted()
            backoff.headObserved(bindingId, eventId)
            assertTrue(pacer.sent(generation, eventId))
            return Flight(connection, generation, eventId)
        }

        fun timeout(flight: Flight): Boolean = backoff.timeout(flight.connection, flight.generation, flight.eventId)

        fun ack(flight: Flight, ref: String = flight.eventId, ok: Boolean = true, delete: () -> Int): Boolean =
            backoff.acknowledge(flight.connection, flight.generation, ref, ok, delete)

        fun finish(flight: Flight): Long {
            assertNull(flight.connection.retire())
            pacer.reset()
            return backoff.nextDelay(flight.connection.identity.id)
        }

        fun failedHead(bindingId: String = "binding-a", eventId: String = "head"): Long {
            val flight = attach(bindingId, eventId)
            assertTrue(timeout(flight))
            assertTrue(flight.connection.disconnected)
            return finish(flight)
        }
    }

    @Test fun successfulHellosDoNotEraseTheSameHeadStreakAndTheDelayCaps() {
        val h = Harness()
        val expected = listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L, 30000L)
        assertEquals(expected, expected.map { h.failedHead() })
    }

    @Test fun healthyTransportCanResetItsOwnStreakWithNoHeadStall() {
        val h = Harness()
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L),
            List(7) { h.backoff.nextDelay("binding-a") })
        h.backoff.helloAccepted()
        assertEquals(1000L, h.backoff.nextDelay("binding-a"))
    }

    @Test fun transportFailuresRespectTheHeadFloorWithoutInflatingTheHeadStreak() {
        val h = Harness()
        assertEquals(listOf(1000L, 2000L, 4000L), List(3) { h.failedHead() })
        h.backoff.helloAccepted()
        assertEquals(listOf(4000L, 4000L, 4000L, 8000L, 16000L, 30000L, 30000L),
            List(7) { h.backoff.nextDelay("binding-a") })
        assertEquals(8000L, h.failedHead()) // One more actual head timeout, not a transport streak at the cap.
    }

    @Test fun staleNegativeAndWrongAckDoNotDisarmTheExactFlight() {
        val h = Harness()
        h.failedHead(); h.failedHead()
        val f = h.attach()
        assertFalse(h.ack(f, ref = "other") { error("wrong ACK touched SQLite") })
        assertFalse(h.ack(f, ok = false) { error("negative ACK touched SQLite") })
        assertFalse(h.backoff.acknowledge(f.connection, f.generation - 1, f.eventId, true) { error("old ACK touched SQLite") })
        assertTrue(h.pacer.isInFlight(f.generation, f.eventId))
        assertTrue(h.timeout(f))
        assertEquals(4000L, h.finish(f))
    }

    @Test fun missingOrUncertainDeleteIsNotConfirmedAckProgress() {
        val h = Harness()
        h.failedHead(); h.failedHead()
        val f = h.attach()
        assertThrows(IllegalStateException::class.java) { h.ack(f) { 0 } }
        val unknown = IllegalStateException("fixture write outcome unknown")
        assertSame(unknown, assertThrows(IllegalStateException::class.java) { h.ack(f) { throw unknown } })
        assertTrue(h.pacer.isInFlight(f.generation, f.eventId))
        f.connection.observeDisconnect()
        assertEquals(2000L, h.finish(f))
        assertEquals(4000L, h.failedHead()) // A subsequent successful read still sees the same head.
    }

    @Test fun exactPositiveAckWithOneConfirmedDeletionClearsTheHeadStreak() {
        val h = Harness()
        h.failedHead(); h.failedHead(); h.failedHead()
        val f = h.attach()
        var deletes = 0
        assertTrue(h.ack(f) { ++deletes; 1 })
        assertFalse(h.ack(f) { error("duplicate ACK attempted a deletion") })
        assertEquals(1, deletes)
        assertNull(h.pacer.inFlight)
        assertFalse(h.timeout(f))
        f.connection.observeDisconnect()
        // Check before reading the next head so the result requires the ACK reset itself.
        assertEquals(1000L, h.finish(f))
        assertEquals(1000L, h.failedHead(eventId = "next"))
    }

    @Test fun onlyACompletedDifferentOrEmptyHeadReadClearsWithoutAnAck() {
        for (observed in listOf("next", null)) {
            val h = Harness()
            h.failedHead(); h.failedHead(); h.failedHead()
            h.backoff.helloAccepted() // No authoritative read yet.
            assertEquals(4000L, h.backoff.nextDelay("binding-a"))
            h.backoff.helloAccepted()
            h.backoff.headObserved("binding-a", "head")
            assertEquals(4000L, h.backoff.nextDelay("binding-a"))
            h.backoff.helloAccepted()
            h.backoff.headObserved("binding-a", observed)
            assertEquals(1000L, h.backoff.nextDelay("binding-a"))
            assertEquals(1000L, h.failedHead(eventId = observed ?: "later"))
        }
    }

    @Test fun aStaleOrDuplicateWatchdogCannotClaimTheReplacementFlight() {
        val h = Harness()
        val old = h.attach()
        assertTrue(h.timeout(old))
        assertFalse(h.timeout(old))
        assertEquals(1000L, h.finish(old))
        val current = h.attach()
        assertNotEquals(old.generation, current.generation)
        assertFalse(h.timeout(old))
        assertFalse(h.backoff.timeout(current.connection, old.generation, old.eventId))
        assertFalse(h.backoff.timeout(current.connection, current.generation, "different"))
        assertFalse(current.connection.disconnected)
        assertTrue(h.timeout(current))
        assertFalse(h.timeout(current))
        assertEquals(2000L, h.finish(current))
    }

    @Test fun alreadyObservedCloseDoesNotCountAsAnAckTimeout() {
        for (reason in listOf(null, "ws:4010")) {
            val h = Harness()
            h.failedHead(); h.failedHead()
            val f = h.attach()
            f.connection.observeDisconnect(reason)
            assertFalse(h.timeout(f))
            assertFalse(h.ack(f) { error("closed socket attempted to delete") })
            assertEquals(reason, f.connection.retire())
            h.pacer.reset()
            if (reason == null) assertEquals(2000L, h.backoff.nextDelay("binding-a"))
        }
    }

    private class Callbacks {
        val pending = linkedMapOf<Runnable, Long>()
        var accepting = true
        val watchdog = OutboxAckWatchdog(
            postDelayed = { task, delay -> if (!accepting) false else { pending[task] = delay; true } },
            removeCallbacks = { pending.remove(it) },
            withConnectionLock = { it() },
        )
        fun take(): Runnable = pending.keys.single().also { pending.remove(it) }
    }

    @Test fun ackFirstCancelsTheOldWatchdogAndOnlyTheNextExactEventCanExpire() {
        val h = Harness(); val callbacks = Callbacks()
        val first = h.attach()
        callbacks.watchdog.arm { assertTrue(h.timeout(first)) }
        val dequeued = callbacks.take()
        assertTrue(h.ack(first) { 1 })
        callbacks.watchdog.cancel()
        // The next durable event uses the same connection and local generation.
        val next = first.copy(eventId = "next")
        h.backoff.headObserved(first.connection.identity.id, next.eventId)
        assertTrue(h.pacer.sent(next.generation, next.eventId))
        callbacks.watchdog.arm { assertTrue(h.timeout(next)) }
        dequeued.run()
        assertFalse(first.connection.disconnected)
        assertEquals(listOf(10_000L), callbacks.pending.values.toList())
        val expiry = callbacks.take()
        expiry.run(); expiry.run()
        assertTrue(first.connection.disconnected)
        assertFalse(h.ack(next) { error("late ACK attempted delete") })
        assertEquals(1000L, h.finish(next))
    }

    @Test fun cancellingCompletedOrClosedFlightsDoesNotLeaveQueuedWatchdogs() {
        val callbacks = Callbacks()
        val watchdog = callbacks.watchdog
        repeat(300) {
            watchdog.arm { error("cancelled timer fired") }
            assertEquals(1, callbacks.pending.size)
            watchdog.cancel(); watchdog.cancel()
            assertTrue(callbacks.pending.isEmpty())
        }
        callbacks.accepting = false
        assertThrows(IllegalStateException::class.java) { watchdog.arm { error("failed timer fired") } }
        assertTrue(callbacks.pending.isEmpty())
        callbacks.accepting = true
        var expired = 0
        watchdog.arm { expired++ }
        callbacks.take().run()
        assertEquals(1, expired)
    }

    @Test fun terminalCloseCanStillUpgradeAClaimedTimeoutBeforeRetirement() {
        val h = Harness()
        val f = h.attach()
        assertTrue(h.timeout(f))
        f.connection.observeDisconnect("ws:4010")
        assertEquals("ws:4010", f.connection.retire())
        f.connection.observeDisconnect()
        assertFalse(h.timeout(f))
        assertEquals("ws:4010", f.connection.terminalReason)
    }

    @Test fun equalEventIdOnDifferentBindingDoesNotInheritHeadBackoff() {
        val h = Harness()
        h.failedHead(); h.failedHead(); h.failedHead()
        h.backoff.helloAccepted()
        assertEquals(1000L, h.backoff.nextDelay("binding-b"))
        assertEquals(1000L, h.failedHead(bindingId = "binding-b"))
        assertEquals(2000L, h.failedHead(bindingId = "binding-b"))
    }
}
