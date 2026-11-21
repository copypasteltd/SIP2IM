package io.voipgw.protocol

/** A repeated command may reuse its prior acknowledgment only for identical task and payload. */
object SmsReservationDecision {
    enum class Result { NEW, DUPLICATE, CONFLICT }
    fun decide(storedTask: String?, storedPayload: String?, task: String, payload: String): Result = when {
        storedTask == null -> Result.NEW
        storedTask == task && storedPayload == payload -> Result.DUPLICATE
        else -> Result.CONFLICT
    }
}
