package io.voipgw.protocol

/** Storage must atomically persist claim before submit; exceptions leave an unknown outcome. */
class SmsSubmission(private val claim: (String) -> Boolean, private val submit: (String) -> Unit) {
    enum class Result { NOT_CLAIMED, SUBMITTED, UNKNOWN }
    fun submitOnce(taskId: String): Result {
        require(taskId.isNotBlank())
        if (!claim(taskId)) return Result.NOT_CLAIMED
        return try { submit(taskId); Result.SUBMITTED } catch (_: Exception) { Result.UNKNOWN }
    }
}
