package io.voipgw.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
class UnknownSimQueueTest {
    @Test fun unknownObservationIsDistinctFromConfirmedUnavailability() {
        assertEquals(SimReadiness.State.UNKNOWN, SimReadiness.decide(SimReadiness.Card.OTHER, null))
        assertEquals(SimReadiness.State.UNKNOWN, SimReadiness.decide(SimReadiness.Card.READY, null))
        assertEquals(SimReadiness.State.UNAVAILABLE, SimReadiness.decide(SimReadiness.Card.ABSENT, null))
    }
}
