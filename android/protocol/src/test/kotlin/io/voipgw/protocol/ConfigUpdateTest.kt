package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class ConfigUpdateTest {
    @Test fun validatesAndRejectsUnsupportedChanges() {
        assertNull(ConfigUpdate.error(emptyMap()))
        assertNull(ConfigUpdate.error(mapOf("heartbeatSec" to 30)))
        assertNull(ConfigUpdate.error(mapOf("locale" to "en")))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("heartbeatSec" to 86401)))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("locale" to "invalid")))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("heartbeatSec" to 0)))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("heartbeatSec" to 1.5)))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("locale" to null)))
        assertEquals("BAD_MESSAGE", ConfigUpdate.error(mapOf("unknown" to true)))
    }
}
