package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class SmsReceiptStateTest {
    @Test fun deliveryBeforeFinalSentStillEmitsOrderedTransitions() {
        val outcome = SmsReceiptState.aggregate(listOf(true, true), listOf(true, true))
        assertEquals(listOf("sent", "delivered"), SmsReceiptState.transitions(null, outcome))
        assertEquals(listOf("delivered"), SmsReceiptState.transitions("sent", outcome))
        assertEquals(listOf("sent", "delivered"), SmsReceiptState.transitions("unknown", outcome))
        assertEquals(listOf("sent"), SmsReceiptState.transitions("unknown", SmsReceiptState.Outcome.SENT))
        assertTrue(SmsReceiptState.transitions("delivered", outcome).isEmpty())
        assertTrue(SmsReceiptState.transitions("failed", outcome).isEmpty())
    }
    @Test fun multipartOutcomesDoNotAssumeDelivery() {
        assertEquals(SmsReceiptState.Outcome.WAITING, SmsReceiptState.aggregate(listOf(true, null), listOf(null, null)))
        assertEquals(SmsReceiptState.Outcome.FAILED, SmsReceiptState.aggregate(listOf(true, false), listOf(null, null)))
        assertEquals(SmsReceiptState.Outcome.SENT, SmsReceiptState.aggregate(listOf(true, true), listOf(true, null)))
        assertEquals(SmsReceiptState.Outcome.DELIVERED, SmsReceiptState.aggregate(listOf(true, true), listOf(true, true)))
        assertEquals(SmsReceiptState.Outcome.SENT, SmsReceiptState.aggregate(listOf(true, true), listOf(true, false)))
    }
}
