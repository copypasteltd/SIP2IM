package io.voipgw.protocol

/**
 * Assemble only parts supplied together by one Android SMS broadcast, in supplied order.
 * Sender equality does not prove concatenation identity or correct part ordering.
 */
object SmsParts {
    data class Part(val from: String, val body: String, val receivedAt: Long)
    data class Message(val from: String, val body: String, val receivedAt: Long, val parts: Int)
    fun assemble(parts: List<Part>): Message {
        require(parts.isNotEmpty())
        val first = parts.first()
        require(parts.all { it.from == first.from })
        return Message(first.from, parts.joinToString("") { it.body }, first.receivedAt, parts.size)
    }
}
