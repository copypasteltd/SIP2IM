package io.voipgw.gateway.core

import io.voipgw.protocol.OutboxPacer

/** Service-lifetime retry state. The caller holds the connection lock and only
 * supplies the current binding/socket and authoritative outbox reads. The
 * transport streak is independent of the one head that has timed out on ACK. */
internal class OutboxReconnectBackoff(private val pacer: OutboxPacer) {
    private data class Stall(val bindingId: String, val eventId: String, val index: Int) {
        fun matches(bindingId: String, eventId: String?) = this.bindingId == bindingId && this.eventId == eventId
    }

    private var transportIndex = 0
    private var stall: Stall? = null

    fun helloAccepted() { transportIndex = 0 }

    /** Only a completed read counts; a read exception is not an empty queue. */
    fun headObserved(bindingId: String, eventId: String?) {
        if (stall?.matches(bindingId, eventId) != true) stall = null
    }

    fun acknowledge(connection: BindingConnection, generation: Long, eventId: String, ok: Boolean, delete: () -> Int): Boolean {
        if (connection.disconnected) return false
        if (!pacer.acknowledged(generation, eventId, ok) {
                check(!connection.disconnected) { "Outbox ACK connection closed" }
                check(delete() == 1) { "Outbox ACK deletion not confirmed" }
            }) return false
        if (stall?.matches(connection.identity.id, eventId) == true) stall = null
        return true
    }

    /** Claim the deadline only once while this exact event is still in flight. */
    fun timeout(connection: BindingConnection, generation: Long, eventId: String): Boolean {
        if (!pacer.isInFlight(generation, eventId) || !connection.tryBeginRetryableDisconnect()) return false
        val bindingId = connection.identity.id
        val previous = stall?.takeIf { it.matches(bindingId, eventId) }
        val index = if (previous == null) 0 else (previous.index + 1).coerceAtMost(DELAYS.lastIndex)
        stall = Stall(bindingId, eventId, index)
        return true
    }

    fun nextDelay(bindingId: String): Long {
        val transportDelay = DELAYS[transportIndex]
        transportIndex = (transportIndex + 1).coerceAtMost(DELAYS.lastIndex)
        val headDelay = stall?.takeIf { it.bindingId == bindingId }?.let { DELAYS[it.index] } ?: 0L
        return maxOf(transportDelay, headDelay)
    }

    private companion object { val DELAYS = longArrayOf(1000, 2000, 4000, 8000, 16000, 30000) }
}

/** One scheduled ACK check per connection. The caller serializes arm/cancel
 * with the callback through the existing lifecycle gate and connection lock. */
internal class OutboxAckWatchdog(
    private val postDelayed: (Runnable, Long) -> Boolean,
    private val removeCallbacks: (Runnable) -> Unit,
    private val withConnectionLock: (() -> Unit) -> Unit,
) {
    private var pending: Runnable? = null

    fun arm(onTimeout: () -> Unit) {
        check(pending == null)
        val wake = object : Runnable {
            override fun run() = withConnectionLock {
                if (pending === this) {
                    pending = null
                    onTimeout()
                }
            }
        }
        pending = wake
        if (!postDelayed(wake, 10_000L)) {
            cancel()
            error("Outbox ACK watchdog unavailable")
        }
    }

    fun cancel() {
        val wake = pending ?: return
        pending = null
        removeCallbacks(wake)
    }
}
