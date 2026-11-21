package io.voipgw.gateway.core

/** Process-local observation only; it does not describe service or network availability. */
internal class TerminalConnectionObservation {
    enum class State { UNKNOWN, TERMINAL_CLOSED }
    private var instance: Any? = null
    private var state = State.UNKNOWN
    private val observers = mutableSetOf<() -> Unit>()

    fun beginInstance(): Any {
        val token = Any()
        synchronized(this) { instance = token; state = State.UNKNOWN }
        notifyObservers()
        return token
    }

    // Mutations do not notify: callers may serialize them with their own lock.
    fun terminalClosed(token: Any): Boolean = synchronized(this) {
        if (instance !== token || state == State.TERMINAL_CLOSED) false
        else { state = State.TERMINAL_CLOSED; true }
    }

    fun endInstance(token: Any): Boolean = synchronized(this) {
        if (instance !== token) false
        else { instance = null; state = State.UNKNOWN; true }
    }

    fun current(): State = synchronized(this) { state }
    fun register(observer: () -> Unit) { synchronized(this) { observers.add(observer) } }
    fun unregister(observer: () -> Unit) { synchronized(this) { observers.remove(observer) } }
    fun notifyObservers() {
        val copy = synchronized(this) { observers.toList() }
        copy.forEach { try { it() } catch (_: RuntimeException) { } }
    }
}

internal object GatewayConnectionObservation {
    val state = TerminalConnectionObservation()
}
