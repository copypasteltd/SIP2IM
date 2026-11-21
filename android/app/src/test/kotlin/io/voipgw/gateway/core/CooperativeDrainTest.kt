package io.voipgw.gateway.core

import java.util.ArrayDeque
import org.junit.Assert.*
import org.junit.Test

class CooperativeDrainTest {
    private class Harness {
        val loop = ArrayDeque<Runnable>()
        val rows = mutableListOf(1L, 2L, 3L, 4L, 5L)
        val seen = mutableListOf<Long>()
        var paused = false
        var boundaries = 0
        var pages = 0
        val drain = CooperativeDrain<Long>(
            post = { loop.addLast(it) }, stopped = { false }, paused = { paused },
            boundary = { boundaries++; rows.maxOrNull() },
            page = { after, upper -> pages++; rows.filter { (after == null || it > after) && it <= upper }.take(2) },
            key = { it }, process = { seen.add(it) }
        )
        fun tick() = loop.removeFirst().run()
        fun runAll() { var budget = 100; while (loop.isNotEmpty()) { check(budget-- > 0); tick() } }
    }

    @Test fun pagesAndTasksYieldSeparatelyAndUnknownDoesNotStarve() {
        val h = Harness(); h.drain.wake()
        h.tick(); assertEquals(0, h.pages); assertTrue(h.seen.isEmpty())
        h.tick(); assertEquals(1, h.pages); assertTrue(h.seen.isEmpty())
        h.tick(); assertEquals(listOf(1L), h.seen)
        h.runAll(); assertEquals(listOf(1L, 2L, 3L, 4L, 5L), h.seen)
        assertEquals(1, h.boundaries)
        h.drain.wake(); h.runAll(); assertEquals(10, h.seen.size)
    }

    @Test fun additionsWaitForCoalescedFreshPassAndRemovedRowsAreSkipped() {
        val h = Harness(); h.drain.wake(); h.tick(); h.tick(); h.tick()
        h.rows.remove(4L); h.rows.add(6L); h.drain.wake(); h.drain.wake(); h.runAll()
        assertEquals(listOf(1L, 2L, 3L, 5L, 1L, 2L, 3L, 5L, 6L), h.seen)
        assertEquals(2, h.boundaries)
    }

    @Test fun pauseDiscardsPageAndResumesWithNewBoundary() {
        val h = Harness(); h.drain.wake(); h.tick(); h.tick(); h.tick()
        h.paused = true; h.tick(); assertTrue(h.loop.isEmpty())
        h.paused = false; h.drain.wake(); h.runAll()
        assertEquals(listOf(1L, 1L, 2L, 3L, 4L, 5L), h.seen)
        assertEquals(2, h.boundaries)
    }

    @Test fun emptyAndErrorsLeaveDrainWakeable() {
        val h = Harness(); h.rows.clear(); h.drain.wake(); h.runAll()
        h.rows.add(1L); h.drain.wake(); h.runAll(); assertEquals(listOf(1L), h.seen)
        val loop = ArrayDeque<Runnable>(); var calls = 0
        val drain = CooperativeDrain<Long>({ loop.addLast(it) }, { false }, { false },
            { if (calls++ == 0) error("db") else null }, { _, _ -> emptyList() }, { it }, { })
        drain.wake(); loop.removeFirst().run(); drain.wake(); loop.removeFirst().run()
        assertEquals(2, calls)
    }
}
