package io.voipgw.protocol

import org.junit.Assert.*
import org.junit.Test

class CommandValidationTest {
    private val id = "cmd_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    @Test fun requiredFieldsAndPause() {
        val sms = mapOf("taskId" to "tsk_test", "subId" to null, "slot" to 0, "to" to "+861234", "body" to "hello")
        assertTrue(CommandValidation.valid(id, "sms.send", sms))
        assertFalse(CommandValidation.valid(id, "sms.send", sms - "subId"))
        assertFalse(CommandValidation.valid("cmd_bad", "sms.send", sms))
    }
    @Test fun rejectBadDtmf() {
        assertTrue(CommandValidation.valid(id, "call.dtmf", mapOf("callId" to "cal_test", "digits" to "1*#")))
        assertFalse(CommandValidation.valid(id, "call.dtmf", mapOf("callId" to "cal_test", "digits" to "1x")))
    }
    @Test fun unsupportedCallPayloadsRequireTypedFields() {
        val media = mapOf("sessionId" to "ses_test", "legId" to "leg_test", "path" to "/ws/media", "format" to 1)
        val dial = mapOf("callId" to "cal_test", "slot" to 0, "subId" to null, "to" to "+123", "media" to media)
        val answer = mapOf("callId" to "cal_test", "media" to media)
        assertTrue(CommandValidation.valid(id, "call.dial", dial))
        assertFalse(CommandValidation.valid(id, "call.dial", dial - "subId"))
        assertFalse(CommandValidation.valid(id, "call.dial", dial + ("slot" to "0")))
        assertTrue(CommandValidation.valid(id, "call.answer", answer))
        assertFalse(CommandValidation.valid(id, "call.answer", answer + ("media" to (media + ("format" to "1")))))
        assertFalse(CommandValidation.valid(id, "call.dtmf", mapOf("callId" to "cal_test", "digits" to "")))
        assertFalse(CommandValidation.valid(id, "call.dtmf", mapOf("callId" to "cal_test", "digits" to 1)))
    }
    @Test fun optionalCallGenerationMustBeCanonical() {
        val legacy = mapOf("callId" to "cal_test", "digits" to "12#")
        val generation = "gen_01ARZ3NDEKTSV4RRFFQ69G5FAV"
        assertTrue(CommandValidation.valid(id, "call.dtmf", legacy))
        assertTrue(CommandValidation.valid(id, "call.dtmf", legacy + ("generation" to generation)))
        assertFalse(CommandValidation.valid(id, "call.dtmf", legacy + ("generation" to null)))
        assertFalse(CommandValidation.valid(id, "call.dtmf", legacy + ("generation" to "gen_bad")))
        assertFalse(CommandValidation.valid(id, "call.dtmf", legacy + ("generation" to 1)))
        val media = mapOf("sessionId" to "s", "legId" to "l", "path" to "/ws/media", "format" to 1)
        val commands = mapOf(
            "call.dial" to mapOf("callId" to "c", "slot" to 0, "subId" to null, "to" to "123", "media" to media),
            "call.answer" to mapOf("callId" to "c", "media" to media),
            "call.reject" to mapOf("callId" to "c"),
            "call.hangup" to mapOf("callId" to "c")
        )
        for ((type, payload) in commands) {
            assertTrue(CommandValidation.valid(id, type, payload))
            assertTrue(CommandValidation.valid(id, type, payload + ("generation" to generation)))
            assertFalse(CommandValidation.valid(id, type, payload + ("generation" to "gen_bad")))
            assertFalse(CommandValidation.valid(id, type, payload + ("generation" to null)))
        }
    }
    @Test fun assembleOnlyMatchingParts() {
        val message = SmsParts.assemble(listOf(SmsParts.Part("sender", "a", 1), SmsParts.Part("sender", "b", 2)))
        assertEquals("ab", message.body); assertEquals(2, message.parts)
        try { SmsParts.assemble(listOf(SmsParts.Part("a", "a", 0), SmsParts.Part("b", "b", 1))); fail() } catch (_: IllegalArgumentException) { }
    }
}
