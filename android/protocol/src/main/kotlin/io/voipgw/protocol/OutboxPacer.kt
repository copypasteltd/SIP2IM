package io.voipgw.protocol

/** Tracks one queued event per connection generation. No callback runs under the lock. */
class OutboxPacer {
    private var generation = 0L
    @Volatile var inFlight: String? = null
        private set

    @Synchronized fun generation(): Long = generation
    @Synchronized fun sent(generation: Long, id: String): Boolean {
        if (this.generation != generation || inFlight != null) return false
        inFlight = id
        return true
    }
    @Synchronized fun isInFlight(generation: Long, id: String): Boolean =
        this.generation == generation && inFlight == id

    fun acknowledged(generation: Long, id: String, ok: Boolean, delete: () -> Unit): Boolean {
        if (!ok || !isInFlight(generation, id)) return false
        delete()
        return synchronized(this) {
            if (this.generation != generation || inFlight != id) false
            else { inFlight = null; true }
        }
    }
    @Synchronized fun reset() { generation++; inFlight = null }
}
