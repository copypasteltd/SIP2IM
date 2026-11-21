package io.voipgw.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class SimReadinessTest {
    @Test fun incompleteBootObservationDefersUntilReady() {
        assertEquals(SimReadiness.State.UNKNOWN, SimReadiness.decide(SimReadiness.Card.OTHER, null))
        assertEquals(SimReadiness.State.UNKNOWN, SimReadiness.decide(SimReadiness.Card.READY, null))
        assertEquals(SimReadiness.State.UNAVAILABLE, SimReadiness.decide(SimReadiness.Card.READY, false))
        assertEquals(SimReadiness.State.READY, SimReadiness.decide(SimReadiness.Card.READY, true))
    }
    @Test fun identityEvidenceRequiresAnUnambiguousSlot() {
        assertEquals(false, SimReadiness.subscriptionMatch(0, 10, listOf(0 to 11)))
        assertEquals(true, SimReadiness.subscriptionMatch(0, 10, listOf(0 to 10, 1 to 11)))
        assertEquals(null, SimReadiness.subscriptionMatch(0, 10, null))
        assertEquals(null, SimReadiness.subscriptionMatch(0, 10, emptyList()))
        assertEquals(null, SimReadiness.subscriptionMatch(0, 10, listOf(0 to 10, 0 to 11)))
        assertEquals(null, SimReadiness.subscriptionMatch(0, 10, listOf(0 to 10, 1 to 10)))
        assertEquals(SimReadiness.State.UNAVAILABLE, SimReadiness.decide(SimReadiness.Card.OTHER, false))
    }
    @Test fun explicitAbsentOrLockedIsUnavailable() {
        assertEquals(SimReadiness.State.UNAVAILABLE, SimReadiness.decide(SimReadiness.Card.ABSENT, null))
        assertEquals(SimReadiness.State.UNAVAILABLE, SimReadiness.decide(SimReadiness.Card.LOCKED, false))
    }
}
