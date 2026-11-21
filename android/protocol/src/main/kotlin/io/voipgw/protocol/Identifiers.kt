package io.voipgw.protocol

import java.security.SecureRandom

/** Time-based ULID with cryptographically random 80-bit suffix. */
object Identifiers {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()
    fun event(now: Long = System.currentTimeMillis()): String {
        require(now in 0..0xffffffffffffL)
        val bytes = ByteArray(16)
        for (i in 0..5) bytes[i] = (now ushr (40 - 8 * i)).toByte()
        val entropy = ByteArray(10); random.nextBytes(entropy)
        System.arraycopy(entropy, 0, bytes, 6, 10)
        val out = StringBuilder("evt_")
        for (group in 0 until 26) {
            var value = 0
            for (bit in 0 until 5) {
                val position = group * 5 + bit - 2
                value = value shl 1
                if (position >= 0) value = value or ((bytes[position / 8].toInt() ushr (7 - position % 8)) and 1)
            }
            out.append(ALPHABET[value])
        }
        return out.toString()
    }
}
