package io.voipgw.gateway.core

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import io.voipgw.protocol.BindingAddress

/** Keep credentials, pending binding and terminal connection state in one private database. */
internal class Credentials(context: Context) {
    val fence = sharedFence(context.applicationContext)

    fun state(): BindingFence.State = fence.state()

    companion object {
        private var shared: BindingFence? = null
        private val observers = mutableSetOf<() -> Unit>()

        // All relevant app components run in the same process. Only the exact owner
        // of an OPEN record may release it, including across service recreation.
        @Synchronized private fun sharedFence(app: Context): BindingFence = shared ?: BindingFence(
            SqliteBindingStore(Outbox.shared(app)),
            { app.getSharedPreferences("credentials", Context.MODE_PRIVATE).all.isNotEmpty() }
        ).also { shared = it }

        @Synchronized fun registerBindingObserver(observer: () -> Unit) { observers.add(observer) }
        @Synchronized fun unregisterBindingObserver(observer: () -> Unit) { observers.remove(observer) }

        fun notifyBindingObservers() {
            val copy = synchronized(this) { observers.toList() }
            copy.forEach { observer -> try { observer() } catch (_: RuntimeException) { } }
        }
    }
}

private class SqliteBindingStore(private val helper: Outbox) : BindingStore {
    override fun read() = readRecord(helper.readableDatabase)

    override fun replace(expected: BindingRecord, next: BindingRecord): Boolean {
        val db = helper.writableDatabase
        db.beginTransaction()
        try {
            val current = readRecord(db)
            if (!expected.matches(current)) return false
            val values = ContentValues().apply {
                put("singleton", 1)
                put("phase", next.phase.name)
                put("binding_id", next.id)
                put("device_id", next.identity?.deviceId)
                put("token", next.identity?.token)
                put("origin", next.identity?.origin)
                put("connection_id", next.generation)
                put("reason", next.reason)
                val pending = next.pending
                put("replay_version", pending?.version)
                put("replay_attempt_id", pending?.attemptId)
                put("replay_bearer", pending?.bearer)
                put("replay_origin", pending?.origin)
                put("replay_code", pending?.code)
                put("replay_manufacturer", pending?.metadata?.manufacturer)
                put("replay_model", pending?.metadata?.model)
                put("replay_api_level", pending?.metadata?.apiLevel)
                put("replay_apk_version", pending?.metadata?.apkVersion)
                put("replay_apk_code", pending?.metadata?.apkCode)
                put("replay_locale", pending?.metadata?.locale)
            }
            check(db.update("gateway_binding", values, "singleton = 1", null) == 1)
            db.setTransactionSuccessful()
            return true
        } finally { db.endTransaction() }
    }

    private fun readRecord(db: SQLiteDatabase): BindingRecord? = db.query(
        "gateway_binding", arrayOf(
            "phase", "binding_id", "device_id", "token", "origin", "connection_id", "reason",
            "replay_version", "replay_attempt_id", "replay_bearer", "replay_origin", "replay_code",
            "replay_manufacturer", "replay_model", "replay_api_level", "replay_apk_version", "replay_apk_code", "replay_locale"
        ),
        "singleton = 1", null, null, null, null
    ).use { row ->
        if (!row.moveToFirst()) return@use null
        val phase = BindingRecord.Phase.valueOf(row.getString(0))
        val id = row.getString(1)
        val identity = when (phase) {
            BindingRecord.Phase.UNBOUND, BindingRecord.Phase.LEGACY, BindingRecord.Phase.PENDING -> null
            else -> BoundIdentity(
                checkNotNull(id).also { check(it.isNotBlank()) },
                row.getString(2).also { check(!it.isNullOrBlank()) },
                row.getString(3).also { check(!it.isNullOrBlank()) },
                row.getString(4).also { check(!it.isNullOrBlank() && BindingAddress.origin(it) == it) }
            )
        }
        val pending = if (row.isNull(7)) {
            check((8..17).all { row.isNull(it) })
            null
        } else {
            check(phase == BindingRecord.Phase.PENDING && !id.isNullOrBlank())
            fun integer(column: Int, min: Int): Int {
                check(row.getType(column) == Cursor.FIELD_TYPE_INTEGER)
                val value = row.getLong(column)
                check(value in min.toLong()..Int.MAX_VALUE.toLong())
                return value.toInt()
            }
            check(listOf(8, 9, 10, 11, 12, 13, 15, 17).all { row.getType(it) == Cursor.FIELD_TYPE_STRING })
            val version = integer(7, 2)
            val apiLevel = integer(14, 1)
            val apkCode = integer(16, 0)
            PendingBinding(version, row.getString(8), row.getString(9), row.getString(10), row.getString(11),
                BindingMetadata(row.getString(12), row.getString(13), apiLevel, row.getString(15), apkCode, row.getString(17)))
        }
        BindingRecord(phase, id, identity, row.getString(5), row.getString(6), pending)
    }
}
