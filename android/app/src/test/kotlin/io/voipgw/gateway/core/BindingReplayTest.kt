package io.voipgw.gateway.core

import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import java.util.Random
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

internal fun bindingFixture() = PendingBinding.create(
    "http://offline.invalid:47860", Random(18).nextInt(1_000_000).toString().padStart(6, '0'),
    BindingMetadata("maker", "fixture", 19, "v0", 1, "en")
)

class BindingReplayTest {
    private class Disk : BindingStore {
        enum class Fault { BEFORE_WRITE, AFTER_WRITE, READBACK }

        var record = BindingRecord(BindingRecord.Phase.UNBOUND)
        var fault: Fault? = null
        var missReadback = false
        private var ids = 0

        fun reopen() = BindingFence(this, { false }) { "generation-" + ++ids }
        override fun read(): BindingRecord? {
            if (!missReadback) return record
            missReadback = false
            return null
        }

        override fun replace(expected: BindingRecord, next: BindingRecord): Boolean {
            if (!expected.matches(record)) return false
            val effect = fault.also { fault = null }
            if (effect == Fault.BEFORE_WRITE) error("Rolled back")
            record = next
            if (effect == Fault.AFTER_WRITE) error("Commit acknowledgement lost")
            if (effect == Fault.READBACK) missReadback = true
            return true
        }
    }

    @Test fun proofLossThenExplicitResumeAfterRestartUsesDurableExactRequest() {
        val disk = Disk()
        val first = disk.reopen()
        val draft = bindingFixture()
        val sent = mutableListOf<PendingBinding>()
        val initial = BindingReplay(first, exchange = { pending ->
            assertEquals(draft, disk.record.pending)
            assertNotEquals(disk.record.id, pending.attemptId)
            assertNull(first.openConnection())
            sent.add(pending)
            throw java.io.IOException("Reply lost")
        })
        assertEquals(BindingReplay.Result.UNCERTAIN, initial.start { draft })
        assertEquals(BindingFence.State.PENDING_REPLAY, first.state())

        val reopened = disk.reopen()
        val resume = BindingReplay(reopened, exchange = {
            sent.add(it)
            proof(it)
        })
        assertEquals(1, sent.size)
        assertEquals(BindingReplay.Result.UNAVAILABLE, resume.start { fail("Minted a replacement"); bindingFixture() })
        assertEquals(1, sent.size)
        assertEquals(BindingReplay.Result.SUCCESS, resume.resume())
        assertEquals(listOf(draft, draft), sent)
        assertEquals(sent.first().requestBody(), sent.last().requestBody())
        assertNull(disk.record.pending)
        assertEquals(BindingFence.State.BOUND, disk.reopen().state())
        val bound = checkNotNull(reopened.openConnection()).identity
        assertEquals(DEVICE, bound.deviceId)
        assertEquals(draft.bearer, bound.token)
        assertEquals(draft.origin, bound.origin)
        assertEquals("generation-1", bound.id)
    }

    @Test fun unconfirmedFirstWriteNeverSendsOrMintsAnotherRequestInProcess() {
        for (fault in Disk.Fault.entries) {
            val disk = Disk().apply { this.fault = fault }
            val fence = disk.reopen()
            val attempt = bindingFixture()
            var posts = 0
            val replay = BindingReplay(fence, exchange = { ++posts; proof(it) })
            assertEquals(BindingReplay.Result.UNCERTAIN, replay.start { attempt })
            assertEquals(0, posts)
            assertEquals(BindingReplay.Result.UNAVAILABLE, replay.start { error("Minted a replacement") })
            if (fault == Disk.Fault.BEFORE_WRITE) {
                assertEquals(BindingFence.State.RECONCILIATION, fence.state())
                assertEquals(BindingReplay.Result.UNAVAILABLE, replay.resume())
                assertEquals(0, posts)
            } else {
                assertEquals(attempt, disk.record.pending)
                assertEquals(BindingFence.State.PENDING_REPLAY, fence.state())
                assertEquals(BindingReplay.Result.SUCCESS, replay.resume())
                assertEquals(1, posts)
            }
        }
    }

    @Test fun uncertainPromotionRecoversEitherTheSamePendingOrTheCompleteActiveRow() {
        for (fault in Disk.Fault.entries) {
            val disk = Disk()
            val fence = disk.reopen()
            val attempt = bindingFixture()
            val replay = BindingReplay(fence, exchange = { disk.fault = fault; proof(it) })
            assertEquals(BindingReplay.Result.UNCERTAIN, replay.start { attempt })
            assertNull(fence.openConnection())
            val reopened = disk.reopen()
            when (fault) {
                Disk.Fault.BEFORE_WRITE -> {
                    assertEquals(attempt, disk.record.pending)
                    assertEquals(BindingReplay.Result.SUCCESS, BindingReplay(reopened, exchange = ::proof).resume())
                }
                Disk.Fault.AFTER_WRITE, Disk.Fault.READBACK -> assertEquals(BindingFence.State.BOUND, reopened.state())
            }
            assertNull(disk.record.pending)
            assertEquals(attempt.bearer, disk.record.identity?.token)
            assertEquals(attempt.origin, disk.record.identity?.origin)
        }
    }

    @Test fun promotionChecksTheWholePendingRowAndExactAttemptEcho() {
        val disk = Disk()
        val fence = disk.reopen()
        val draft = bindingFixture()
        val saved = checkNotNull(fence.beginBinding(draft))
        assertFalse(fence.finishBinding(saved, proof(draft.copy(attemptId = alternate(draft.attemptId)))))
        disk.record = BindingRecord(saved.phase, "new-generation", pending = draft)
        assertFalse(fence.finishBinding(saved, proof(draft)))
        disk.record = BindingRecord(saved.phase, saved.id, pending = draft.copy(metadata = draft.metadata.copy(locale = "zh-HK")))
        assertFalse(fence.finishBinding(saved, proof(draft)))
        disk.record = saved
        assertTrue(fence.finishBinding(saved, proof(draft)))
        assertFalse(fence.finishBinding(saved, proof(draft)))
    }

    @Test fun overlappingActionsCannotSendAndBackoffNeverSchedulesAReplay() {
        val disk = Disk()
        val entered = CountDownLatch(1)
        val respond = CountDownLatch(1)
        val result = AtomicReference<BindingReplay.Result>()
        var posts = 0
        var time = 0L
        val replay = BindingReplay(disk.reopen(), exchange = {
            if (++posts == 1) {
                entered.countDown()
                assertTrue(respond.await(5, TimeUnit.SECONDS))
                null
            } else proof(it)
        }, clockMillis = { time })
        val worker = thread { result.set(replay.start(::bindingFixture)) }
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertTrue(replay.isRunning())
            assertEquals(BindingReplay.Result.BUSY, replay.resume())
            assertEquals(BindingReplay.Result.BUSY, replay.start { error("Minted a concurrent request") })
        } finally {
            respond.countDown()
            worker.join(5_000)
        }
        assertEquals(BindingReplay.Result.UNCERTAIN, result.get())
        assertEquals(BindingReplay.Result.BACKOFF, replay.resume())
        time += 2_000
        assertEquals(1, posts)
        assertEquals(BindingReplay.Result.SUCCESS, replay.resume())
        assertEquals(2, posts)
    }

    @Test fun canonicalBase64UrlMatchesJdkForBothLengthsAndRejectsAliases() {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        val source = Random(47)
        for (size in listOf(16, 32)) repeat(64) {
            val bytes = ByteArray(size).also(source::nextBytes)
            val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
            assertTrue(BindingV2Encoding.canonical(encoded, size))
            assertFalse(BindingV2Encoding.canonical(encoded + "=", size))
            assertFalse(BindingV2Encoding.canonical(encoded.dropLast(1) + alphabet[alphabet.indexOf(encoded.last()) + 1], size))
            assertFalse(BindingV2Encoding.canonical(encoded, if (size == 16) 32 else 16))
            val generated = BindingV2Encoding.random(size)
            assertEquals(size, Base64.getUrlDecoder().decode(generated).size)
            assertTrue(BindingV2Encoding.canonical(generated, size))
        }
    }

    @Test fun exactResponseAndNoStoreAreRequiredForAllNetworkResults() {
        val pending = bindingFixture()
        val body = reply(pending)
        val request = BindingV2Http.request(pending)
        val invalidBodies = listOf(
            body.replace("\"protocolVersion\":2", "\"protocolVersion\":\"2\""),
            body.replace("\"protocolVersion\":2", "\"protocolVersion\":2.0"),
            body.replace("\"protocolVersion\":2", "\"protocolVersion\":1"),
            body.replace("\"protocolVersion\":2", "\"protocolVersion\":2,\"protocolVersion\":2"),
            body.replace("\"protocolVersion\":2", "protocolVersion:2"),
            body.replace("\"deviceId\":", "\"deviceId\":null,\"ignored\":"),
            body.replace(DEVICE, "invalid-device"),
            body.dropLast(2) + ",\"token\":\"unexpected\"}}",
            body.dropLast(1) + ",\"extra\":false}",
            body + "{}",
            " ".repeat(BindingProof.MAX_BYTES) + body
        )
        fun response(status: Int, payload: String, noStore: Boolean = true) = Response.Builder()
            .request(request).code(status).message("fixture").protocol(Protocol.HTTP_1_1)
            .header("Cache-Control", if (noStore) "no-store" else "no-cache")
            .body(ResponseBody.create(null, payload)).build()
        val accepted = response(200, body).use(BindingV2Http::readProof)
        assertEquals(pending.attemptId, accepted?.attemptId)
        assertEquals(DEVICE, accepted?.deviceId)
        assertNotNull(BindingProof.parse("{ \"data\" : { \"deviceId\" : \"$DEVICE\", \"attemptId\" : \"" +
            pending.attemptId + "\", \"protocolVersion\" : 2 } }"))
        for (malformed in invalidBodies) assertNull(response(200, malformed).use(BindingV2Http::readProof))
        for (status in listOf(201, 307, 400, 404, 410, 429, 503)) assertNull(response(status, body).use(BindingV2Http::readProof))
        assertNull(response(200, body, noStore = false).use(BindingV2Http::readProof))
    }

    @Test fun requestUsesTheExactAdditiveRouteAndHeaderAndEscapesFrozenJson() {
        val draft = bindingFixture()
        val pending = draft.copy(metadata = draft.metadata.copy(model = "Model \"A\"\\🔧\n"))
        val request = BindingV2Http.request(pending)
        assertEquals("POST", request.method())
        assertEquals(pending.origin + "/api/device/bind-v2", request.url().toString())
        assertEquals("Bearer " + pending.bearer, request.header("Authorization"))
        assertEquals("no-store", request.header("Cache-Control"))
        val body = Buffer().also { request.body()!!.writeTo(it) }.readUtf8()
        assertTrue("\"model\":\"Model \\\"A\\\"\\\\🔧\\u000a\"" in body)
        assertTrue("\"protocolVersion\":2,\"attemptId\":\"" + pending.attemptId + "\"" in body)
        assertTrue("\"code\":\"" + pending.code + "\"" in body)
        assertFalse(pending.bearer in body || pending.origin in body)
        assertThrows(IllegalArgumentException::class.java) { draft.metadata.copy(locale = "x".repeat(65)) }
        assertThrows(IllegalArgumentException::class.java) { draft.metadata.copy(model = "bad\u0000") }
        assertThrows(IllegalArgumentException::class.java) { draft.metadata.copy(model = "bad\ud800") }
    }

    private fun alternate(id: String) = (if (id.first() == 'A') 'B' else 'A') + id.drop(1)
    private fun proof(pending: PendingBinding) = checkNotNull(BindingProof.parse(reply(pending)))
    private fun reply(pending: PendingBinding) = "{\"data\":{\"protocolVersion\":2,\"attemptId\":\"" +
        pending.attemptId + "\",\"deviceId\":\"$DEVICE\"}}"

    private companion object { const val DEVICE = "dev_01AZ0X6P4DF7HM0KENT2Q84Y6W" }
}
