package io.voipgw.gateway.sms

import android.app.Activity
import android.telephony.SmsManager

/** The task is single-claim; its persisted binding and connection fence identify that claim. */
internal data class SmsSendAttempt(val taskId: String, val bindingId: String, val connectionId: String) {
    init {
        require(TASK_ID.matches(taskId) && LOCAL_ID.matches(bindingId) && LOCAL_ID.matches(connectionId))
    }

    fun sentReceiptUri(index: Int): String {
        require(index >= 0)
        return "voipgw-sms://receipt/v2/$taskId/$bindingId/$connectionId/$index/sent"
    }

    data class Receipt(val attempt: SmsSendAttempt, val index: Int)

    companion object {
        private val TASK_ID = Regex("tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}")
        private val LOCAL_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        private val SENT_URI = Regex(
            "voipgw-sms://receipt/v2/(${TASK_ID.pattern})/(${LOCAL_ID.pattern})/(${LOCAL_ID.pattern})/(0|[1-9][0-9]{0,9})/sent"
        )

        fun parseSentReceipt(uri: String): Receipt? {
            val match = SENT_URI.matchEntire(uri) ?: return null
            val (task, binding, connection, part) = match.destructured
            return Receipt(SmsSendAttempt(task, binding, connection), part.toIntOrNull() ?: return null)
        }
    }
}

/** Preserve both directions of a contradictory part in the existing nullable INTEGER column. */
internal enum class SmsPartEvidence(val stored: Int) {
    FAILED(0), SENT(1), CONFLICT(2);

    fun merge(incoming: SmsPartEvidence): SmsPartEvidence = if (this == incoming) this else CONFLICT

    companion object {
        fun fromStored(value: Int): SmsPartEvidence = entries.single { it.stored == value }

        fun fromSentResult(code: Int): SmsPartEvidence? = when (code) {
            Activity.RESULT_OK -> SENT
            // A transport exception does not establish what the remote telephony service did.
            SmsManager.RESULT_REMOTE_EXCEPTION -> null
            // Public send errors in SDK 35; exclude RESULT_CANCELED / RESULT_ERROR_NONE (0),
            // an unrecognized code, and receive-only errors. None proves carrier delivery.
            in SmsManager.RESULT_ERROR_GENERIC_FAILURE..SmsManager.RESULT_USER_NOT_ALLOWED,
            in SmsManager.RESULT_RIL_RADIO_NOT_AVAILABLE..SmsManager.RESULT_RIL_ABORTED -> FAILED
            else -> null
        }
    }
}

internal enum class SmsSendEvidence(val state: String, val errorCode: String? = null) {
    SENT("sent"), FAILED("failed", "SMS_SEND_FAILED"), PARTIAL("unknown", "SMS_PARTIAL_SEND"),
    CONFLICT("unknown", "SMS_CALLBACK_CONFLICT");

    data class Update(val part: SmsPartEvidence, val newResult: SmsSendEvidence?)

    companion object {
        /** Compare verdicts as well as wire state: partial and conflict are distinct unknowns. */
        fun apply(parts: Map<Int, SmsPartEvidence?>, index: Int, incoming: SmsPartEvidence): Update? {
            if (!parts.containsKey(index)) return null
            val previous = parts[index]
            val merged = previous?.merge(incoming) ?: incoming
            if (merged == previous) return null
            val before = aggregate(parts.values)
            val after = aggregate((parts + (index to merged)).values)
            return Update(merged, after?.takeIf { it != before })
        }

        fun aggregate(parts: Collection<SmsPartEvidence?>): SmsSendEvidence? {
            require(parts.isNotEmpty())
            if (SmsPartEvidence.CONFLICT in parts) return CONFLICT
            val sent = SmsPartEvidence.SENT in parts
            val failed = SmsPartEvidence.FAILED in parts
            if (sent && failed) return PARTIAL
            if (null in parts) return null  // No unanimous conclusion while any part is absent.
            return if (sent) SENT else FAILED
        }
    }
}
