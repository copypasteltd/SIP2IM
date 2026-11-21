package io.voipgw.protocol

/** Unknown observations stay unknown on the wire. */
object HeartbeatState {
    fun observed(value: String?): String = value ?: "unknown"
    fun <T> optionalObservation(read: () -> T?): T? = try { read() } catch (_: RuntimeException) { null }
}
