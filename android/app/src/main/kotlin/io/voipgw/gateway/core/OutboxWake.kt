package io.voipgw.gateway.core

/** Process-local notification only; never starts a service. */
object OutboxWake {
    private var listener: (() -> Unit)? = null
    @Synchronized fun register(callback: () -> Unit) { listener = callback }
    @Synchronized fun unregister(callback: () -> Unit) { if (listener === callback) listener = null }
    fun notifyCommitted() { val callback = synchronized(this) { listener }; callback?.invoke() }
}
