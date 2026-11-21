package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class SmsSubmissionTest {
    @Test fun duplicateNeverSubmitsTwice() {
        val claimed = mutableSetOf<String>(); var calls = 0
        val sender = SmsSubmission({ claimed.add(it) }, { calls++ })
        assertEquals(SmsSubmission.Result.SUBMITTED, sender.submitOnce("task"))
        assertEquals(SmsSubmission.Result.NOT_CLAIMED, sender.submitOnce("task"))
        assertEquals(1, calls)
    }
    @Test fun exceptionStaysUnknownAndCannotRetry() {
        val claimed = mutableSetOf<String>(); var calls = 0
        val sender = SmsSubmission({ claimed.add(it) }, { calls++; error("uncertain") })
        assertEquals(SmsSubmission.Result.UNKNOWN, sender.submitOnce("task"))
        assertEquals(SmsSubmission.Result.NOT_CLAIMED, sender.submitOnce("task"))
        assertEquals(1, calls)
    }
}
