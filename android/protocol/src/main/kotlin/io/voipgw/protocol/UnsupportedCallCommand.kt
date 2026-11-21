package io.voipgw.protocol

/** Without a verified call-to-Telecom mapping, never claim that a call is absent. */
object UnsupportedCallCommand {
    fun error(callId: String?): String = if (callId.isNullOrBlank()) "BAD_MESSAGE" else "CAPABILITY_UNSUPPORTED"
}
