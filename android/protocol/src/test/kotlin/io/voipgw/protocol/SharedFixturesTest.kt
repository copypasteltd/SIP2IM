package io.voipgw.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedFixturesTest {
    private fun rows(path: String, columns: List<String>): List<List<String>> {
        val resource = requireNotNull(javaClass.getResourceAsStream("/voipgw-fixtures/$path")) {
            "Missing shared fixture $path on the test classpath"
        }
        val lines = resource.bufferedReader(Charsets.UTF_8).use { it.readLines() }
        assertTrue("No cases in $path", lines.size > 1)
        assertEquals(path, columns, lines.first().split('\t'))
        return lines.drop(1).map { line ->
            line.split('\t').also { assertEquals(line, columns.size, it.size) }
        }
    }

    private fun hexToBytes(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "Invalid byte vector $hex" }
        return hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }

    @Test fun callRejectCommandIdentityAndGeneration() {
        val cases = rows("device/call-reject-generation.tsv", listOf("name", "commandId", "callId", "generation", "valid"))
        for ((name, commandId, callId, generation, valid) in cases) {
            val payload = if (generation == "-") mapOf("callId" to callId)
            else mapOf("callId" to callId, "generation" to generation)
            assertEquals(name, valid.toBooleanStrict(), CommandValidation.valid(commandId, "call.reject", payload))
        }
    }

    @Test fun mediaFrameBytesAndDecodeErrors() {
        val cases = rows("media-v1.tsv", listOf("name", "valid", "headerHex", "pcmSampleHex", "pcmSamples", "format", "flags", "seq", "captureTs"))
        for (row in cases) {
            val (name, valid, headerHex, sampleHex, samples) = row
            val pcm = hexToBytes(sampleHex.repeat(samples.toInt()))
            val wire = hexToBytes(headerHex) + pcm
            if (!valid.toBooleanStrict()) {
                assertThrows(name, IllegalArgumentException::class.java) { MediaFrame.decode(wire) }
                continue
            }
            val expected = MediaFrame(row[5].toInt(), row[6].toInt(), row[7].toLong(), row[8].toLong(), pcm)
            val decoded = MediaFrame.decode(wire)
            assertEquals(name, expected.format, decoded.format)
            assertEquals(name, expected.flags, decoded.flags)
            assertEquals(name, expected.sequence, decoded.sequence)
            assertEquals(name, expected.captureTs, decoded.captureTs)
            assertArrayEquals(name, expected.pcm, decoded.pcm)
            assertArrayEquals(name, wire, expected.encode())
        }
    }
}
