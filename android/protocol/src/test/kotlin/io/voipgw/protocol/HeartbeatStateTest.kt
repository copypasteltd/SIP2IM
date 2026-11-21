package io.voipgw.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
class HeartbeatStateTest {
    @Test fun failedOptionalObservationIsNull() {
        assertEquals(null, HeartbeatState.optionalObservation<Int> { throw SecurityException("denied") })
        assertEquals(null, HeartbeatState.optionalObservation<Int> { throw IllegalStateException("unavailable") })
        assertEquals(42, HeartbeatState.optionalObservation { 42 })
    }
    @Test fun missingObservationsDoNotImplyStoppedOrOffline() {
        assertEquals("unknown", HeartbeatState.observed(null))
        assertEquals("running", HeartbeatState.observed("running"))
        assertEquals("none", HeartbeatState.observed("none"))
    }
}
