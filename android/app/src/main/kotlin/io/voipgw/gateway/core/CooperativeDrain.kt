package io.voipgw.gateway.core

/** All methods and callbacks run on the same event loop; post must enqueue, never run inline. */
internal class CooperativeDrain<T>(
    private val post: (Runnable) -> Unit,
    private val stopped: () -> Boolean,
    private val paused: () -> Boolean,
    private val boundary: () -> Long?,
    private val page: (Long?, Long) -> List<T>,
    private val key: (T) -> Long,
    private val process: (T) -> Unit
) {
    private var active = false
    private var wakePending = false
    private var entries: Iterator<T>? = null
    private var upper: Long? = null
    private var started = false
    private var after: Long? = null

    fun wake() {
        if (stopped()) return
        if (active) { wakePending = true; return }
        active = true
        post(Runnable { step() })
    }

    private fun step() {
        if (stopped() || paused()) { finish(false); return }
        try {
            if (!started) {
                upper = boundary()
                started = true
                if (upper == null) { finish(true); return }
                post(Runnable { step() })
                return
            }
            val current = entries
            if (current != null && current.hasNext()) {
                val entry = current.next()
                after = key(entry)
                process(entry)
                post(Runnable { step() })
                return
            }
            val rows = page(after, upper!!)
            if (rows.isEmpty()) { finish(true); return }
            entries = rows.iterator()
            // Fetching a page and processing an entry are separate event-loop turns.
            post(Runnable { step() })
        } catch (_: Exception) {
            // A coalesced external wake gets one fresh pass; otherwise wait for a wake.
            finish(true)
        }
    }

    private fun finish(allowPendingWake: Boolean) {
        entries = null
        upper = null
        started = false
        after = null
        active = false
        val again = wakePending && allowPendingWake
        wakePending = false
        if (again) wake()
    }
}
