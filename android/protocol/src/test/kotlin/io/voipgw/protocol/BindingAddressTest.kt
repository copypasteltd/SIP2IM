package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test
class BindingAddressTest {
    @Test fun validOriginAndCode() {
        assertEquals("http://example.test:47860", BindingAddress.origin("http://example.test:47860/"))
        assertTrue(BindingAddress.code("012345")); assertFalse(BindingAddress.code("12345"))
    }
    @Test fun rejectCredentialsAndPaths() {
        for (value in listOf("http://user:pass@example.test", "http://example.test/a", "http://example.test/?token=x", "https://example.test")) {
            try { BindingAddress.origin(value); fail(value) } catch (_: IllegalArgumentException) { }
        }
    }
}
