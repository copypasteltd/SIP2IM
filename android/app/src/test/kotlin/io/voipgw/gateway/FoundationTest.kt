package io.voipgw.gateway

import io.voipgw.gateway.platform.ApiLevel
import io.voipgw.gateway.telephony.EmergencyGuard
import org.junit.Assert.*
import org.junit.Test

class FoundationTest {
    @Test fun apiBoundaries() {
        assertEquals(listOf("L1", "L1", "L2", "L3", "L3", "L4", "L4", "L5"), listOf(19, 21, 22, 23, 25, 26, 32, 33).map(ApiLevel::tier))
    }
    @Test fun emergencyNumbers() {
        for (n in listOf("110", "119", "120", "122", "112", "999")) assertTrue(EmergencyGuard.isEmergency(n))
        assertTrue(EmergencyGuard.isEmergency("1 1-2")); assertFalse(EmergencyGuard.isEmergency("1120"))
    }
}
