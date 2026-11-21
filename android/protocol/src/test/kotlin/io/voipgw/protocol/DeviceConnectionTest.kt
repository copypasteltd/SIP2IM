package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class DeviceConnectionTest {
    @Test fun sendsHelloThenSnapshotThenEvents() {
        val sent = mutableListOf<String>()
        val connection = DeviceConnection { sent.add(it); true }
        assertTrue(connection.opened("hello"))
        assertTrue(connection.accepted("snapshot", listOf("event1", "event2")))
        assertEquals(listOf("hello", "snapshot", "event1", "event2"), sent)
    }
    @Test fun failedSnapshotDoesNotFlushEvents() {
        val sent = mutableListOf<String>()
        val connection = DeviceConnection { sent.add(it); it != "snapshot" }
        connection.opened("hello")
        try { connection.accepted("snapshot", listOf("event")); fail() } catch (_: IllegalStateException) { }
        assertEquals(listOf("hello", "snapshot"), sent)
    }
}
