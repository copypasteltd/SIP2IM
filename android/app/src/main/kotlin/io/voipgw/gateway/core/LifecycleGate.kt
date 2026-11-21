package io.voipgw.gateway.core

/** Rejects new work after stop and invokes cleanup once the last admitted call leaves. */
internal class LifecycleGate {
    private var closed = false
    private var active = 0
    private var cleanup: (() -> Unit)? = null

    fun run(block: () -> Unit) {
        synchronized(this) { if (closed) return; active++ }
        try { block() } finally {
            val done = synchronized(this) {
                active--
                if (closed && active == 0) cleanup.also { cleanup = null } else null
            }
            done?.invoke()
        }
    }

    fun close(afterDrain: () -> Unit) {
        val done = synchronized(this) {
            if (closed) return
            closed = true
            if (active == 0) afterDrain else { cleanup = afterDrain; null }
        }
        done?.invoke()
    }
}
