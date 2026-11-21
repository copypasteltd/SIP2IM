package io.voipgw.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

/** One protocol-v1 20 ms mono PCM16 frame. Unsigned fields are represented by Long. */
data class MediaFrame(val format: Int, val flags: Int, val sequence: Long, val captureTs: Long, val pcm: ByteArray) {
    fun encode(): ByteArray {
        validate(format, flags, sequence, captureTs, pcm.size)
        return ByteBuffer.allocate(12 + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
            .put(1).put(format.toByte()).put(flags.toByte()).put(0)
            .putInt(sequence.toInt()).putInt(captureTs.toInt()).put(pcm).array()
    }
    companion object {
        fun decode(bytes: ByteArray): MediaFrame {
            require(bytes.size >= 12) { "short frame" }
            val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            require(buffer.get().toInt() == 1) { "unsupported version" }
            val format = buffer.get().toInt() and 255
            val flags = buffer.get().toInt() and 255
            require(buffer.get().toInt() == 0) { "reserved byte" }
            val seq = buffer.int.toLong() and 0xffffffffL
            val ts = buffer.int.toLong() and 0xffffffffL
            val pcm = ByteArray(buffer.remaining()); buffer.get(pcm)
            validate(format, flags, seq, ts, pcm.size)
            return MediaFrame(format, flags, seq, ts, pcm)
        }
        private fun validate(format: Int, flags: Int, seq: Long, ts: Long, size: Int) {
            val length = when (format) { 1 -> 320; 2 -> 640; 3 -> 1920; else -> throw IllegalArgumentException("unknown format") }
            require(flags in 0..7 && seq in 0..0xffffffffL && ts in 0..0xffffffffL)
            require(size == if (flags and 4 != 0) 0 else length) { "invalid payload length" }
        }
    }
}
