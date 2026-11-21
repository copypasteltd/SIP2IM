package io.voipgw.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
class SmsReservationDecisionTest {
    @Test fun repeatedCommandsRequireIdenticalContent() {
        assertEquals(SmsReservationDecision.Result.NEW, SmsReservationDecision.decide(null, null, "task", "payload"))
        assertEquals(SmsReservationDecision.Result.DUPLICATE, SmsReservationDecision.decide("task", "payload", "task", "payload"))
        assertEquals(SmsReservationDecision.Result.CONFLICT, SmsReservationDecision.decide("task", "payload", "task", "different"))
    }
}
