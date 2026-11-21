package io.voipgw.gateway.core

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class LifecycleGateTest {
    @Test fun stopRejectsNewWorkAndWaitsForAdmittedWork() {
        val gate = LifecycleGate()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val worker = Thread { gate.run { entered.countDown(); release.await() } }
        worker.start(); assertTrue(entered.await(2, TimeUnit.SECONDS))
        gate.close { finished.countDown() }
        var invoked = false
        gate.run { invoked = true }
        assertFalse(invoked); assertEquals(1L, finished.count)
        release.countDown(); assertTrue(finished.await(2, TimeUnit.SECONDS)); worker.join(2000)
    }

    @Test fun queuedWorkIsRejectedAfterStop() {
        val gate = LifecycleGate(); var ran = false; var closed = false
        val queued = Runnable { gate.run { ran = true } }
        gate.close { closed = true }; queued.run()
        assertTrue(closed); assertFalse(ran)
    }

    @Test fun cleanupRunsExactlyOnceEvenWhenWorkThrows() {
        val gate = LifecycleGate(); var cleanups = 0
        try { gate.run { gate.close { cleanups++ }; throw IllegalStateException() } } catch (_: IllegalStateException) { }
        gate.close { cleanups++ }; gate.run { fail("work admitted after stop") }
        assertEquals(1, cleanups)
    }
}
