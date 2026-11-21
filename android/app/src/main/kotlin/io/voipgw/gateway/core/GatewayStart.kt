package io.voipgw.gateway.core

import android.content.Context
import android.content.Intent
import android.os.Build

/** Request outcomes only; process-local and never evidence that the service is running. */
object GatewayStart {
    enum class State { UNKNOWN, REQUESTING, ACCEPTED, FAILED }
    private var state = State.UNKNOWN
    private val observers = mutableSetOf<() -> Unit>()

    fun current(): State = synchronized(this) { state }
    fun register(observer: () -> Unit) { synchronized(this) { observers.add(observer) } }
    fun unregister(observer: () -> Unit) { synchronized(this) { observers.remove(observer) } }
    private fun notifyObservers() {
        val copy = synchronized(this) { observers.toList() }
        copy.forEach { try { it() } catch (_: RuntimeException) { } }
    }

    /**
     * Automatic requests happen once per process; retries require a user action.
     * The durable binding state gates both requests. Acceptance only describes Android
     * accepting the start request.
     */
    fun request(context: Context, retry: Boolean = false) {
        val app = context.applicationContext
        if (Credentials(app).state() != BindingFence.State.BOUND) return
        synchronized(this) {
            if (if (retry) state != State.FAILED && state != State.ACCEPTED else state != State.UNKNOWN) return
            state = State.REQUESTING
        }
        notifyObservers()
        val accepted = try {
            val service = Intent(app, GatewayService::class.java).setAction(GatewayService.ACTION_INITIAL_BIND)
            (if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(service) else app.startService(service)) != null
        } catch (_: RuntimeException) { false }
        synchronized(this) { state = if (accepted) State.ACCEPTED else State.FAILED }
        notifyObservers()
    }
}
