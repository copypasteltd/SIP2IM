package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class MediaFrameTest {
    @Test fun roundTripUnsignedAndLittleEndian() {
        val raw = MediaFrame(1, 1, 0xffffffffL, 0x12345678L, ByteArray(320)).encode()
        assertEquals(255, raw[4].toInt() and 255); assertEquals(0x78, raw[8].toInt() and 255)
        val decoded = MediaFrame.decode(raw)
        assertEquals(0xffffffffL, decoded.sequence); assertEquals(0x12345678L, decoded.captureTs)
        assertArrayEquals(ByteArray(320), decoded.pcm)
    }
    @Test fun silenceAndMalformedFrames() {
        assertEquals(12, MediaFrame(2, 4, 0, 0, byteArrayOf()).encode().size)
        for (input in listOf(ByteArray(11), ByteArray(12), MediaFrame(1, 0, 0, 0, ByteArray(320)).encode().also { it[3] = 1 })) {
            try { MediaFrame.decode(input); fail("invalid frame accepted") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun identifiersHaveExpectedPrefixAndAlphabet() {
        val id = Identifiers.event(0)
        assertTrue(id.matches(Regex("evt_[0-7][0-9A-HJKMNP-TV-Z]{25}")))
        assertEquals("0000000000", id.substring(4, 14))
    }
}
