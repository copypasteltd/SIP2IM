package io.voipgw.protocol

/** Tracks connection sequencing. The caller performs IO and supplies fresh snapshots. */
class ConnectionPolicy {
    enum class Phase { DISCONNECTED, AWAITING_HELLO, READY }
    var phase: Phase = Phase.DISCONNECTED
        private set
    private var failures = 0

    fun connected() { check(phase == Phase.DISCONNECTED); phase = Phase.AWAITING_HELLO }
    /** Caller must send snapshot before any outbox event after this transition. */
    fun helloAccepted(sendSnapshot: () -> Unit, flushOutbox: () -> Unit) {
        check(phase == Phase.AWAITING_HELLO)
        sendSnapshot()
        phase = Phase.READY
        failures = 0
        flushOutbox()
    }
    fun disconnected(): Long {
        phase = Phase.DISCONNECTED
        val delays = longArrayOf(1, 2, 4, 8, 16, 30)
        val seconds = delays[failures.coerceAtMost(delays.lastIndex)]
        failures = (failures + 1).coerceAtMost(delays.lastIndex)
        return seconds * 1000
    }
}
