package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class SmsPartsTest {
    @Test fun sameBroadcastPartsKeepSuppliedOrderAndFirstTimestampAcrossLargeGaps() {
        val message = SmsParts.assemble(listOf(
            SmsParts.Part("sender", "first", Long.MAX_VALUE),
            SmsParts.Part("sender", " second", Long.MIN_VALUE),
            SmsParts.Part("sender", " third", 0)
        ))
        assertEquals("sender", message.from)
        assertEquals("first second third", message.body)
        assertEquals(Long.MAX_VALUE, message.receivedAt)
        assertEquals(3, message.parts)
    }

    @Test fun rejectsEmptyAndMixedSenders() {
        try { SmsParts.assemble(emptyList()); fail("empty parts accepted") } catch (_: IllegalArgumentException) { }
        try {
            SmsParts.assemble(listOf(SmsParts.Part("a", "x", 0), SmsParts.Part("b", "y", 0)))
            fail("mixed senders accepted")
        } catch (_: IllegalArgumentException) { }
    }
}
