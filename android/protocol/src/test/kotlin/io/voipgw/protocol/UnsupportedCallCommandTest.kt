package io.voipgw.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
class UnsupportedCallCommandTest {
    @Test fun unknownCallsAreNotReportedAsAlreadyEnded() {
        assertEquals("BAD_MESSAGE", UnsupportedCallCommand.error(null))
        assertEquals("BAD_MESSAGE", UnsupportedCallCommand.error("  "))
        assertEquals("CAPABILITY_UNSUPPORTED", UnsupportedCallCommand.error("cal_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    }
}
