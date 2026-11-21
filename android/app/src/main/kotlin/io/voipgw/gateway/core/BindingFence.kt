package io.voipgw.gateway.core

import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/** The local identity generation also scopes queued work. It is independent of the wire attempt ID. */
internal class BoundIdentity(val id: String, val deviceId: String, val token: String, val origin: String) {
    fun matches(other: BoundIdentity?) = other != null && id == other.id && deviceId == other.deviceId &&
        token == other.token && origin == other.origin
}

internal class BindingConnection(val identity: BoundIdentity, val generation: String) {
    private data class Disconnect(val terminalReason: String?, val retired: Boolean = false)
    private val disconnect = AtomicReference<Disconnect?>()
    val disconnected: Boolean get() = disconnect.get() != null
    val terminalReason: String? get() = disconnect.get()?.terminalReason

    /** Win the local timeout only if the transport has not already reported a close. */
    fun tryBeginRetryableDisconnect(): Boolean = disconnect.compareAndSet(null, Disconnect(null))

    // Stop admitting new effects even if the close callback is waiting for the service lock.
    fun observeDisconnect(reason: String? = null) {
        while (true) {
            val observed = disconnect.get()
            if (observed?.retired == true || observed?.terminalReason != null || (observed != null && reason == null)) return
            if (disconnect.compareAndSet(observed, Disconnect(reason))) return
        }
    }

    fun retire(): String? {
        while (true) {
            val observed = disconnect.get()
            if (observed?.retired == true) return observed.terminalReason
            val final = Disconnect(observed?.terminalReason, retired = true)
            if (disconnect.compareAndSet(observed, final)) return final.terminalReason
        }
    }
}

internal class BindingRecord(
    val phase: Phase,
    val id: String? = null,
    val identity: BoundIdentity? = null,
    val generation: String? = null,
    val reason: String? = null,
    val pending: PendingBinding? = null
) {
    enum class Phase { UNBOUND, LEGACY, PENDING, IDLE, OPEN, TERMINAL }

    fun isReplayable(): Boolean = phase == Phase.PENDING && !id.isNullOrBlank() && pending != null &&
        identity == null && generation == null && reason == null

    fun matches(other: BindingRecord?): Boolean = other != null && phase == other.phase && id == other.id &&
        generation == other.generation && reason == other.reason && pending == other.pending &&
        (if (identity == null) other.identity == null else identity.matches(other.identity))
}

internal interface BindingStore {
    fun read(): BindingRecord?
    fun replace(expected: BindingRecord, next: BindingRecord): Boolean
}

/** SQLite is authoritative. An open record with no process owner requires reconciliation. */
internal class BindingFence(
    private val store: BindingStore,
    private val legacyPreferencesPresent: () -> Boolean,
    private val newId: () -> String = { UUID.randomUUID().toString() }
) {
    enum class State { UNBOUND, PENDING_REPLAY, BOUND, RECONCILIATION, TERMINAL }

    private var uncertain = false
    private var unconfirmedBindingWrite = false
    private var owned: BindingConnection? = null
    private var observedTerminal = false

    @Synchronized fun state(): State {
        if (observedTerminal || owned?.terminalReason != null) return State.TERMINAL
        return checked(State.RECONCILIATION) {
            val current = store.read()
            when {
                current?.phase == BindingRecord.Phase.TERMINAL -> State.TERMINAL
                legacyPreferencesPresent() -> State.RECONCILIATION
                current == null -> State.RECONCILIATION
                current.isReplayable() -> State.PENDING_REPLAY
                unconfirmedBindingWrite -> State.RECONCILIATION
                BindingRecord(BindingRecord.Phase.UNBOUND).matches(current) -> State.UNBOUND
                current.phase == BindingRecord.Phase.IDLE && current.identity != null -> State.BOUND
                current.phase == BindingRecord.Phase.OPEN && owned?.let { current.matches(openRecord(it)) } == true -> State.BOUND
                else -> State.RECONCILIATION
            }
        }
    }

    @Synchronized fun beginBinding(pending: PendingBinding): BindingRecord? = checked(null) {
        val unbound = BindingRecord(BindingRecord.Phase.UNBOUND)
        if (unconfirmedBindingWrite || legacyPreferencesPresent() || !unbound.matches(store.read())) return@checked null
        val next = BindingRecord(BindingRecord.Phase.PENDING, newId(), pending = pending)
        if (persistBinding(unbound, next)) next else null
    }

    @Synchronized fun pendingBinding(): BindingRecord? = checked(null) {
        if (legacyPreferencesPresent()) null else store.read()?.takeIf { it.isReplayable() }
    }

    @Synchronized fun finishBinding(expected: BindingRecord, proof: BindingProof): Boolean = checked(false) {
        if (!expected.isReplayable() || legacyPreferencesPresent() || !expected.matches(store.read())) return@checked false
        val pending = checkNotNull(expected.pending)
        if (pending.attemptId != proof.attemptId) return@checked false
        val id = checkNotNull(expected.id)
        val next = BindingRecord(BindingRecord.Phase.IDLE, id, BoundIdentity(id, proof.deviceId, pending.bearer, pending.origin))
        persistBinding(expected, next)
    }

    private fun persistBinding(expected: BindingRecord, next: BindingRecord): Boolean {
        unconfirmedBindingWrite = true
        // The store returns only after its transaction ends. Read back the complete committed row.
        val confirmed = try {
            store.replace(expected, next) && next.matches(store.read())
        } catch (_: Exception) { false }
        if (confirmed) unconfirmedBindingWrite = false
        return confirmed
    }

    @Synchronized fun openConnection(): BindingConnection? = checked(null) {
        if (unconfirmedBindingWrite || legacyPreferencesPresent() || owned != null) return@checked null
        val current = store.read() ?: return@checked null
        val identity = current.identity ?: return@checked null
        if (current.phase != BindingRecord.Phase.IDLE) return@checked null
        val connection = BindingConnection(identity, newId())
        if (!replace(current, openRecord(connection))) return@checked null
        owned = connection
        connection
    }

    @Synchronized fun owns(connection: BindingConnection): Boolean = checked(false) {
        owned === connection && !connection.disconnected && !legacyPreferencesPresent() && openRecord(connection).matches(store.read())
    }

    @Synchronized fun closeConnection(connection: BindingConnection, terminalReason: String?): Boolean {
        if (owned !== connection) return false
        owned = null
        if (terminalReason != null) observedTerminal = true
        return checked(false) {
            val identity = connection.identity
            val next = if (terminalReason == null) BindingRecord(BindingRecord.Phase.IDLE, identity.id, identity)
            else BindingRecord(BindingRecord.Phase.TERMINAL, identity.id, identity, reason = terminalReason)
            replace(openRecord(connection), next)
        }
    }

    private fun openRecord(connection: BindingConnection) = BindingRecord(
        BindingRecord.Phase.OPEN, connection.identity.id, connection.identity, connection.generation
    )

    private fun replace(expected: BindingRecord, next: BindingRecord): Boolean {
        val changed = store.replace(expected, next)
        if (!changed) uncertain = true
        return changed
    }

    private fun <T> checked(fallback: T, action: () -> T): T {
        if (uncertain) return fallback
        return try { action() } catch (_: Exception) {
            uncertain = true
            fallback
        }
    }
}

/** Coordinates socket callbacks, queued work and the final external submission within one service. */
internal class GatewayExecution(private val fence: BindingFence) {
    enum class Hello { ACCEPTED, DUPLICATE, IDENTITY_MISMATCH, STALE }

    private var current: BindingConnection? = null
    private var ready = false

    @Synchronized fun open(): BindingConnection? {
        if (current != null) return null
        return fence.openConnection()?.also { current = it }
    }

    @Synchronized fun hello(connection: BindingConnection, deviceId: Any?, configure: () -> Unit): Hello {
        if (current !== connection || connection.disconnected) return Hello.STALE
        if (deviceId !is String || deviceId != connection.identity.deviceId) {
            connection.observeDisconnect("hello.identity")
            ready = false
            return Hello.IDENTITY_MISMATCH
        }
        if (!fence.owns(connection)) return Hello.STALE
        if (ready) return Hello.DUPLICATE
        configure()
        if (connection.disconnected) return Hello.STALE
        ready = true
        return Hello.ACCEPTED
    }

    @Synchronized fun isReady(connection: BindingConnection) = current === connection && ready && !connection.disconnected

    @Synchronized fun <T : Any> runReady(connection: BindingConnection, paused: () -> Boolean, action: () -> T): T? {
        if (!isReady(connection) || !fence.owns(connection) || paused() || !isReady(connection)) return null
        return action()
    }

    @Synchronized fun close(connection: BindingConnection): Boolean {
        if (current !== connection) return false
        val terminalReason = connection.retire()
        ready = false
        current = null
        return fence.closeConnection(connection, terminalReason)
    }

    companion object {
        fun terminalReason(code: Int): String? = when (code) {
            4003, 4005, 4010, 4011 -> "ws:$code"
            else -> null
        }
    }
}
