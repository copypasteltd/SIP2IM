package io.voipgw.gateway.core

import org.junit.Assert.*
import org.junit.Test

class HelloDeadlineTest {
    private class Harness {
        var elapsed = 3_000L
        var current: Any? = null
        var rejectPosts = false
        val waiting = linkedMapOf<Runnable, Long>()
        val retired = mutableListOf<Any>()
        var removed = 0

        fun open(owner: Any) = HelloDeadline(
            now = { elapsed },
            postDelayed = { callback, delay ->
                if (rejectPosts) false else {
                    assertTrue(delay > 0L)
                    check(waiting.put(callback, delay) == null)
                    true
                }
            },
            removeCallbacks = { waiting.remove(it); removed++ },
            withCurrent = { task -> if (current === owner) task() },
            onExpired = {
                retired.add(owner)
                if (current === owner) current = null
            },
        ).also { current = owner }

        fun takeWake(): Runnable = waiting.keys.single().also { waiting.remove(it) }
    }

    @Test fun silentUpgradedPeerIsRetiredAtTheDeadlineExactlyOnce() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        assertTrue(deadline.arm())
        assertEquals(listOf(10_000L), h.waiting.values.toList())
        val wake = h.takeWake()
        h.elapsed += 10_000L
        wake.run(); wake.run()
        assertEquals(listOf(owner), h.retired)
        assertNull(h.current)
        assertFalse(deadline.allowsReply())
        assertTrue(h.waiting.isEmpty())
    }

    @Test fun acceptsOnlyBeforeDeadlineEvenWhenTheScheduledWakeHasNotRun() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        assertFalse(deadline.allowsReply()) // Not yet upgraded/armed.
        assertTrue(deadline.arm())
        h.elapsed += 9_999L
        assertTrue(deadline.allowsReply())
        h.elapsed++
        assertFalse(deadline.allowsReply())
        assertEquals(listOf(owner), h.retired)
        assertTrue(h.waiting.isEmpty())
    }

    @Test fun earlyWakeSchedulesOnlyTheUnspentTimeAndCannotExtendTheBudget() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        assertTrue(deadline.arm())
        h.elapsed += 4_500L
        h.takeWake().run()
        assertEquals(listOf(5_500L), h.waiting.values.toList())
        assertFalse(deadline.arm()) // Repeated onOpen cannot move the deadline.
        h.elapsed += 25_000L
        h.takeWake().run()
        assertEquals(listOf(owner), h.retired)
        assertTrue(h.waiting.isEmpty())
    }

    @Test fun acceptedHelloDisarmsTimeoutAndStillLetsTheBindingFenceCheckDuplicateReplies() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        assertTrue(deadline.arm())
        val staleWake = h.waiting.keys.single()
        h.elapsed += 9_999L
        assertTrue(deadline.allowsReply())
        deadline.accepted()
        assertTrue(h.waiting.isEmpty())
        h.elapsed += 60_000L
        staleWake.run()
        assertTrue(deadline.allowsReply())
        assertSame(owner, h.current)
        assertTrue(h.retired.isEmpty())
        deadline.close(); deadline.close()
        assertFalse(deadline.allowsReply())
        assertEquals(2, h.removed)
    }

    @Test fun oldCallbackCannotRetireReplacementOrRestartAClosedTimer() {
        val h = Harness(); val first = Any(); val old = h.open(first)
        assertTrue(old.arm())
        val stale = h.takeWake()
        h.elapsed += 4_000L
        val second = Any(); val replacement = h.open(second)
        assertTrue(replacement.arm())
        h.elapsed += 6_000L
        stale.run()
        assertTrue(h.retired.isEmpty())
        assertSame(second, h.current)
        assertEquals(listOf(10_000L), h.waiting.values.toList())
        assertTrue(replacement.allowsReply())
        val stoppedWake = h.waiting.keys.single()
        replacement.close()
        h.elapsed += 20_000L
        stoppedWake.run()
        assertTrue(h.retired.isEmpty()); assertTrue(h.waiting.isEmpty())
    }

    @Test fun unavailableSchedulerRetiresRatherThanLeavingUnboundedAdmission() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        h.rejectPosts = true
        assertFalse(deadline.arm())
        assertFalse(deadline.allowsReply())
        assertEquals(listOf(owner), h.retired)
        assertTrue(h.waiting.isEmpty())
        assertFalse(deadline.arm())
        assertEquals(listOf(owner), h.retired)
    }

    @Test fun inabilityToRepostAnEarlyWakeAlsoRetiresTheConnection() {
        val h = Harness(); val owner = Any(); val deadline = h.open(owner)
        assertTrue(deadline.arm())
        h.elapsed += 2_000L
        h.rejectPosts = true
        h.takeWake().run()
        assertEquals(listOf(owner), h.retired)
        assertFalse(deadline.allowsReply())
    }
}
