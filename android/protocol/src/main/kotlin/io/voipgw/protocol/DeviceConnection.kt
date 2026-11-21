package io.voipgw.protocol

/** Transport integration supplies serialization, actual sends and fresh snapshots.
 * On any failed send or exception it must close the transport and call closed() once.
 * Accepted sends are only queued by the transport; events remain until server ack.
 */
class DeviceConnection(private val send: (String) -> Boolean) {
    private val policy = ConnectionPolicy()
    val phase get() = policy.phase
    fun opened(hello: String): Boolean {
        policy.connected()
        return send(hello)
    }
    fun accepted(snapshot: String, pending: List<String>): Boolean {
        var success = true
        policy.helloAccepted(
            { check(send(snapshot)) { "snapshot not accepted by transport" } },
            { for (event in pending) if (!send(event)) { success = false; break } }
        )
        return success
    }
    fun closed(): Long = policy.disconnected()
}
