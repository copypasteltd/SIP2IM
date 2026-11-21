package io.voipgw.gateway.core

import java.util.concurrent.atomic.AtomicBoolean

/** One explicit action per send. The caller owns the worker thread. */
internal class BindingReplay(
    private val fence: BindingFence,
    private val exchange: (PendingBinding) -> BindingProof?,
    private val notifyChanged: () -> Unit = {},
    private val clockMillis: () -> Long = { System.nanoTime() / 1_000_000L }
) {
    enum class Result { SUCCESS, INVALID, UNCERTAIN, BUSY, BACKOFF, UNAVAILABLE }

    private val running = AtomicBoolean()
    private var lastUncertainAt = 0L
    private var retryDelay = 0L

    fun isRunning(): Boolean = running.get()

    fun start(prepare: () -> PendingBinding): Result = exclusive {
        if (fence.state() != BindingFence.State.UNBOUND) return@exclusive Result.UNAVAILABLE
        val pending = try { prepare() } catch (_: Exception) { return@exclusive Result.INVALID }
        val saved = fence.beginBinding(pending) ?: return@exclusive Result.UNCERTAIN
        send(saved)
    }

    fun resume(): Result = exclusive {
        val saved = fence.pendingBinding() ?: return@exclusive Result.UNAVAILABLE
        if (retryDelay > 0 && clockMillis() - lastUncertainAt < retryDelay) return@exclusive Result.BACKOFF
        send(saved)
    }

    private fun send(saved: BindingRecord): Result {
        val proof = try { exchange(checkNotNull(saved.pending)) } catch (_: Exception) { null }
        if (proof != null && fence.finishBinding(saved, proof)) return Result.SUCCESS

        lastUncertainAt = clockMillis()
        retryDelay = (retryDelay * 2).coerceIn(2_000L, 30_000L)
        return Result.UNCERTAIN
    }

    private inline fun exclusive(action: () -> Result): Result {
        if (!running.compareAndSet(false, true)) return Result.BUSY
        return try {
            notifyChanged()
            action()
        } finally {
            running.set(false)
            notifyChanged()
        }
    }
}
