package io.voipgw.gateway.sms

import android.app.Activity
import android.telephony.SmsManager
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SmsSendEvidenceTest {
    private val attempt = SmsSendAttempt(
        "tsk_00000000000000000000000000",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    )

    @Test fun sendReceiptSeparatesTaskBindingConnectionAndPart() {
        val uri = attempt.sentReceiptUri(3)
        assertEquals(SmsSendAttempt.Receipt(attempt, 3), SmsSendAttempt.parseSentReceipt(uri))
        assertEquals(SmsSendAttempt.Receipt(attempt, Int.MAX_VALUE),
            SmsSendAttempt.parseSentReceipt(attempt.sentReceiptUri(Int.MAX_VALUE)))
        assertNotEquals(uri, attempt.sentReceiptUri(4))
        assertNotEquals(uri, attempt.copy(taskId = "tsk_00000000000000000000000001").sentReceiptUri(3))
        val otherIdentity = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
        assertNotEquals(uri, attempt.copy(bindingId = otherIdentity).sentReceiptUri(3))
        assertNotEquals(uri, attempt.copy(connectionId = otherIdentity).sentReceiptUri(3))
    }

    @Test fun noLegacyDeliveryOrMalformedReceiptIsAccepted() {
        val uri = attempt.sentReceiptUri(0)
        for (invalid in listOf(
            "voipgw-sms://receipt/" + attempt.taskId + "/0/sent",
            uri.replace("/sent", "/delivered"),
            uri.replace("/0/sent", "/00/sent"),
            uri.replace("/0/sent", "/-1/sent"),
            uri.replace("/0/sent", "/2147483648/sent"),
            uri.replace("/0/sent", "/%30/sent"),
            uri + "?sim=1", uri + "#data",
            uri.replace("receipt", "receipt:80")
        )) assertNull(invalid, SmsSendAttempt.parseSentReceipt(invalid))
    }

    @Test fun onlyRecognizedPlatformSendResultsChangePartEvidence() {
        assertEquals(SmsPartEvidence.SENT, SmsPartEvidence.fromSentResult(Activity.RESULT_OK))
        assertEquals(SmsPartEvidence.FAILED, SmsPartEvidence.fromSentResult(SmsManager.RESULT_ERROR_NO_SERVICE))
        assertEquals(SmsPartEvidence.FAILED, SmsPartEvidence.fromSentResult(SmsManager.RESULT_REQUEST_NOT_SUPPORTED))
        assertEquals(SmsPartEvidence.FAILED, SmsPartEvidence.fromSentResult(SmsManager.RESULT_RIL_NO_SUBSCRIPTION))
        for (code in listOf(Activity.RESULT_CANCELED, Activity.RESULT_FIRST_USER + 97, -20,
            SmsManager.RESULT_REMOTE_EXCEPTION, SmsManager.RESULT_RECEIVE_DISPATCH_FAILURE)) {
            assertNull(SmsPartEvidence.fromSentResult(code))
        }
    }

    @Test fun incompleteFailureOrSuccessCannotDecideTheWholeMessage() {
        val sent = SmsPartEvidence.SENT
        val failed = SmsPartEvidence.FAILED
        assertNull(SmsSendEvidence.aggregate(listOf(null, null)))
        assertNull(SmsSendEvidence.aggregate(listOf(null, sent, sent)))
        assertNull(SmsSendEvidence.aggregate(listOf(failed, failed, null)))
        assertEquals(SmsSendEvidence.SENT, SmsSendEvidence.aggregate(listOf(sent, sent, sent)))
        assertEquals(SmsSendEvidence.FAILED, SmsSendEvidence.aggregate(listOf(failed, failed, failed)))
    }

    @Test fun mixedPartsArePartialAndContraryRepeatsStayConflicted() {
        val sent = SmsPartEvidence.SENT
        val failed = SmsPartEvidence.FAILED
        assertEquals(SmsSendEvidence.PARTIAL, SmsSendEvidence.aggregate(listOf(failed, null, sent)))
        assertEquals(SmsSendEvidence.PARTIAL, SmsSendEvidence.aggregate(listOf(sent, failed, sent)))
        assertEquals(sent, sent.merge(sent))
        assertEquals(failed, failed.merge(failed))
        val conflict = sent.merge(failed)
        assertEquals(SmsPartEvidence.CONFLICT, conflict)
        assertEquals(conflict, failed.merge(sent))
        assertEquals(conflict, conflict.merge(failed))
        assertEquals(conflict, SmsPartEvidence.fromStored(conflict.stored))
        assertEquals(SmsSendEvidence.CONFLICT, SmsSendEvidence.aggregate(listOf(conflict, null, sent)))
        assertEquals(SmsSendEvidence.CONFLICT, SmsSendEvidence.aggregate(listOf(failed, conflict, sent)))
        assertEquals("unknown", SmsSendEvidence.PARTIAL.state)
        assertEquals("SMS_PARTIAL_SEND", SmsSendEvidence.PARTIAL.errorCode)
        assertEquals("unknown", SmsSendEvidence.CONFLICT.state)
        assertEquals("SMS_CALLBACK_CONFLICT", SmsSendEvidence.CONFLICT.errorCode)
    }

    @Test fun lateContradictionUpdatesEitherPriorTerminalVerdictExactlyOnce() {
        val sent = SmsPartEvidence.SENT
        val failed = SmsPartEvidence.FAILED
        for ((first, contrary) in listOf(sent to failed, failed to sent)) {
            val parts = mutableMapOf<Int, SmsPartEvidence?>(0 to null, 1 to null, 2 to null)
            fun observe(index: Int, evidence: SmsPartEvidence): SmsSendEvidence.Update? =
                SmsSendEvidence.apply(parts, index, evidence)?.also { parts[index] = it.part }

            assertNull(observe(3, first))
            assertEquals(SmsSendEvidence.Update(first, null), observe(2, first))
            assertNull(observe(2, first))
            assertEquals(SmsSendEvidence.Update(first, null), observe(0, first))
            val unanimous = if (first == sent) SmsSendEvidence.SENT else SmsSendEvidence.FAILED
            assertEquals(SmsSendEvidence.Update(first, unanimous), observe(1, first))
            assertEquals(SmsSendEvidence.Update(SmsPartEvidence.CONFLICT, SmsSendEvidence.CONFLICT),
                observe(2, contrary))
            assertNull(observe(2, first))
            assertNull(observe(2, contrary))
            assertEquals(SmsSendEvidence.Update(SmsPartEvidence.CONFLICT, null), observe(0, contrary))
        }
    }

    @Test fun partialThenContradictoryProducesTwoDifferentUnknownResults() {
        val sent = SmsPartEvidence.SENT
        val failed = SmsPartEvidence.FAILED
        val first = mapOf(0 to sent, 1 to null, 2 to null)
        assertEquals(SmsSendEvidence.Update(failed, SmsSendEvidence.PARTIAL),
            SmsSendEvidence.apply(first, 2, failed))
        val partial = first + (2 to failed)
        assertEquals(SmsSendEvidence.Update(sent, null), SmsSendEvidence.apply(partial, 1, sent))
        assertEquals(SmsSendEvidence.Update(SmsPartEvidence.CONFLICT, SmsSendEvidence.CONFLICT),
            SmsSendEvidence.apply(partial, 0, failed))
    }

    @Test fun permissionAndUnsupportedAreDefiniteOnlyBeforeTheClaim() {
        assertEquals("SMS_PERMISSION_MISSING", SmsSender.preflight(false) { error("Must not probe") }?.queuedError)
        assertEquals("CAPABILITY_UNSUPPORTED", SmsSender.preflight(true) { false }?.queuedError)
        assertNull(SmsSender.preflight(true) { true })
        assertNull(SmsSender.Result.UNKNOWN.queuedError)
        assertNull(SmsSender.Result.NOT_SUBMITTED.queuedError)
        assertNull(SmsSender.Result.SUBMITTED.queuedError)
        assertEquals(true, SmsSender.supportsSubscription(21, null))
        assertEquals(false, SmsSender.supportsSubscription(21, 0))
        assertEquals(false, SmsSender.supportsSubscription(22, null))
        assertEquals(false, SmsSender.supportsSubscription(22, -1))
        assertEquals(true, SmsSender.supportsSubscription(22, 0))
    }
}
