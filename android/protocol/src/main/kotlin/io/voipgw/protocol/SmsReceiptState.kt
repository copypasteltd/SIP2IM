package io.voipgw.protocol

/** Stateless aggregation of persisted per-part callback outcomes; null means not yet observed. */
object SmsReceiptState {
    enum class Outcome { SENT, FAILED, DELIVERED, WAITING, UNKNOWN }
    fun transitions(previous: String?, outcome: Outcome): List<String> {
        val state = when (outcome) {
            Outcome.FAILED -> "failed"
            Outcome.SENT -> "sent"
            Outcome.DELIVERED -> "delivered"
            else -> return emptyList()
        }
        if (previous == state || previous == "failed" || previous == "delivered") return emptyList()
        return if (state == "delivered" && (previous == null || previous == "unknown")) listOf("sent", "delivered") else listOf(state)
    }
    fun aggregate(sent: List<Boolean?>, delivered: List<Boolean?>): Outcome {
        require(sent.isNotEmpty() && sent.size == delivered.size)
        if (sent.any { it == false }) return Outcome.FAILED
        if (sent.any { it == null }) return Outcome.WAITING
        if (delivered.all { it == true }) return Outcome.DELIVERED
        // Delivery failure does not negate a successful modem submission.
        return Outcome.SENT
    }
}
