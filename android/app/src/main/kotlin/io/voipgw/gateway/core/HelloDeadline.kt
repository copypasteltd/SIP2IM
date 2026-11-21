package io.voipgw.gateway.core

/** One post-upgrade hello deadline. All calls and [withCurrent] use the service's
 * connection lock; the scheduler only queues callbacks, it does not run them inline.
 * The receiver clock is monotonic, and a delayed wake never extends the deadline. */
internal class HelloDeadline(
    private val now: () -> Long,
    private val postDelayed: (Runnable, Long) -> Boolean,
    private val removeCallbacks: (Runnable) -> Unit,
    private val withCurrent: (() -> Unit) -> Unit,
    private val onExpired: () -> Unit,
) {
    private enum class State { NEW, WAITING, ACCEPTED, CLOSED }
    private var state = State.NEW
    private var startedAt = 0L
    private val wake = Runnable { withCurrent(::checkTimer) }

    fun arm(): Boolean {
        if (state != State.NEW) return false
        startedAt = now()
        state = State.WAITING
        return schedule(WAIT_MILLIS)
    }

    fun allowsReply(): Boolean {
        // Let the binding fence classify duplicate or mismatched replies after readiness.
        if (state == State.ACCEPTED) return true
        if (state != State.WAITING) return false
        if (remaining() > 0L) return true
        expire()
        return false
    }

    fun accepted() {
        check(state == State.WAITING)
        state = State.ACCEPTED
        removeCallbacks(wake)
    }

    fun close() {
        if (state == State.CLOSED) return
        state = State.CLOSED
        removeCallbacks(wake)
    }

    private fun remaining(): Long {
        val elapsed = now() - startedAt
        return if (elapsed in 0 until WAIT_MILLIS) WAIT_MILLIS - elapsed else 0L
    }

    private fun checkTimer() {
        if (state != State.WAITING) return
        schedule(remaining())
    }

    private fun schedule(delay: Long): Boolean {
        if (delay > 0L && postDelayed(wake, delay)) return true
        expire()
        return false
    }

    private fun expire() {
        close()
        onExpired()
    }

    private companion object { const val WAIT_MILLIS = 10_000L }
}
