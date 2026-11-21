package io.voipgw.gateway.sms

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import io.voipgw.gateway.core.BindingConnection
import io.voipgw.gateway.core.Outbox
import io.voipgw.gateway.core.OutboxWake
import io.voipgw.protocol.Identifiers
import io.voipgw.protocol.SmsReceiptState
import org.json.JSONObject

/** All command, task, part and result-event changes share the outbox transaction. */
internal class SmsTaskStore(context: Context) {
    private val helper = Outbox.shared(context)
    data class Ack(val error: String?, val newlyReserved: Boolean)

    fun reserve(connection: BindingConnection, commandId: String, taskId: String, payload: String, error: String?): Ack? {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            if (!isOpen(db, connection)) return null
            db.query("sms_command", arrayOf("task_id", "payload", "error", "binding_id"), "command_id = ?", arrayOf(commandId), null, null, null).use {
                if (it.moveToFirst()) {
                    val same = it.getString(0) == taskId && it.getString(1) == payload && it.getString(3) == connection.identity.id
                    val result = Ack(if (same) it.getString(2) else "CONFLICT", false)
                    db.setTransactionSuccessful(); return result
                }
            }
            var rejection = error
            if (rejection == null) {
                val inserted = db.insertWithOnConflict("sms_task", null, ContentValues().apply {
                    put("task_id", taskId); put("command_id", commandId); put("payload", payload); put("state", "queued")
                    put("binding_id", connection.identity.id); put("connection_id", connection.generation)
                }, SQLiteDatabase.CONFLICT_IGNORE)
                if (inserted == -1L) rejection = "CONFLICT"
            }
            db.insertOrThrow("sms_command", null, ContentValues().apply {
                put("command_id", commandId); put("task_id", taskId); put("payload", payload); put("binding_id", connection.identity.id)
                if (rejection == null) putNull("error") else put("error", rejection)
            })
            db.setTransactionSuccessful()
            return Ack(rejection, rejection == null)
        } finally { db.endTransaction() }
    }

    data class QueueRow(val rowId: Long, val taskId: String, val payload: String)

    // Pass boundaries rely on the current append-only queue: do not delete or requeue
    // tasks, assign or rewrite rowids, or VACUUM the database while a pass is active.
    // SQLite may otherwise reuse or renumber implicit rowids. External changes are unsupported.
    fun queueBoundary(connection: BindingConnection): Long? = helper.readableDatabase.rawQuery(
        "SELECT MAX(rowid) FROM sms_task WHERE binding_id = ? AND connection_id = ? AND state = ?", queueArgs(connection)
    ).use {
        if (it.moveToFirst() && !it.isNull(0)) it.getLong(0).also { id -> check(id != Long.MAX_VALUE) } else null
    }

    private val queueScope = "binding_id = ? AND connection_id = ? AND state = ?"
    private fun queueArgs(connection: BindingConnection) = arrayOf(connection.identity.id, connection.generation, "queued")

    // The scope index stores rowids in order within each queue; LIMIT bounds each page.
    fun queuePage(connection: BindingConnection, after: Long?, boundary: Long, limit: Int): List<QueueRow> {
        require(limit > 0)
        val selection = if (after == null) "$queueScope AND rowid <= ?" else "$queueScope AND rowid > ? AND rowid <= ?"
        val args = queueArgs(connection) + if (after == null) arrayOf(boundary.toString()) else arrayOf(after.toString(), boundary.toString())
        return helper.readableDatabase.query("sms_task", arrayOf("rowid", "task_id", "payload"), selection, args, null, null, "rowid ASC", limit.toString()).use {
            val rows = mutableListOf<QueueRow>()
            while (it.moveToNext()) rows.add(QueueRow(it.getLong(0), it.getString(1), it.getString(2)))
            rows
        }
    }

    private fun isOpen(db: SQLiteDatabase, connection: BindingConnection): Boolean = db.rawQuery(
        "SELECT 1 FROM gateway_binding WHERE singleton = 1 AND phase = 'OPEN' AND binding_id = ? AND connection_id = ?",
        arrayOf(connection.identity.id, connection.generation)
    ).use { it.moveToFirst() }

    /** A queued task has not crossed the modem boundary, so this failure is certain. */
    fun failQueued(connection: BindingConnection, taskId: String, error: String) {
        val db = helper.writableDatabase
        var enqueued = false
        db.beginTransaction()
        try {
            if (!isOpen(db, connection)) return
            val changed = db.update("sms_task", ContentValues().apply { put("state", "failed"); put("emitted", "failed") },
                "$queueScope AND task_id = ?", queueArgs(connection) + taskId)
            if (changed == 1) {
                val now = System.currentTimeMillis()
                val payload = JSONObject().put("taskId", taskId).put("state", "failed").put("errorCode", error).toString()
                insertResult(db, payload, now, connection.identity.id)
                enqueued = true
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        if (enqueued) wakeOutbox()
    }

    /** Commit before crossing the non-transactional Android telephony boundary. */
    fun claimWithParts(connection: BindingConnection, taskId: String, count: Int): Boolean {
        require(count > 0)
        val db = helper.writableDatabase
        var claimed = false
        db.beginTransaction()
        try {
            if (!isOpen(db, connection)) return false
            claimed = db.update("sms_task", ContentValues().apply { put("state", "unknown") },
                "$queueScope AND task_id = ?", queueArgs(connection) + taskId) == 1
            if (claimed) {
                for (index in 0 until count) db.insertOrThrow("sms_part", null, ContentValues().apply { put("task_id", taskId); put("part_index", index) })
                val now = System.currentTimeMillis()
                val payload = JSONObject().put("taskId", taskId).put("state", "unknown").put("errorCode", JSONObject.NULL).toString()
                insertResult(db, payload, now, connection.identity.id)
                db.update("sms_task", ContentValues().apply { put("emitted", "unknown") }, "task_id = ?", arrayOf(taskId))
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        if (claimed) wakeOutbox()
        return claimed
    }

    private fun wakeOutbox() { try { OutboxWake.notifyCommitted() } catch (_: Exception) { /* Durable event remains queued. */ } }

    /** First callback wins; aggregate transition and outbox insertion commit together. */
    fun recordPart(taskId: String, index: Int, delivery: Boolean, success: Boolean) {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val column = if (delivery) "delivered" else "sent"
            val changed = db.update("sms_part", ContentValues().apply { put(column, if (success) 1 else 0) }, "task_id = ? AND part_index = ? AND $column IS NULL", arrayOf(taskId, index.toString()))
            if (changed == 1) {
                val sent = mutableListOf<Boolean?>(); val delivered = mutableListOf<Boolean?>()
                db.query("sms_part", arrayOf("sent", "delivered"), "task_id = ?", arrayOf(taskId), null, null, "part_index").use {
                    while (it.moveToNext()) {
                        sent.add(if (it.isNull(0)) null else it.getInt(0) == 1)
                        delivered.add(if (it.isNull(1)) null else it.getInt(1) == 1)
                    }
                }
                val outcome = SmsReceiptState.aggregate(sent, delivered)
                val (previous, bindingId) = db.query("sms_task", arrayOf("emitted", "binding_id"), "task_id = ?", arrayOf(taskId), null, null, null).use {
                    if (it.moveToFirst()) it.getString(0) to it.getString(1) else return
                }
                val transitions = SmsReceiptState.transitions(previous, outcome)
                if (transitions.isNotEmpty()) {
                    for (transition in transitions) {
                        val now = System.currentTimeMillis()
                        val payload = JSONObject().put("taskId", taskId).put("state", transition).put("errorCode", if (transition == "failed") "SMS_SEND_FAILED" else JSONObject.NULL).toString()
                        insertResult(db, payload, now, bindingId)
                    }
                    db.update("sms_task", ContentValues().apply { put("emitted", transitions.last()) }, "task_id = ?", arrayOf(taskId))
                }
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    private fun insertResult(db: SQLiteDatabase, payload: String, now: Long, bindingId: String?) {
        db.insertOrThrow("outbox", null, ContentValues().apply {
            put("id", Identifiers.event(now)); put("type", "sms.result"); put("payload", payload)
            put("created_at", now); putNull("expires_at"); put("attempts", 0); put("binding_id", bindingId)
        })
    }

}
