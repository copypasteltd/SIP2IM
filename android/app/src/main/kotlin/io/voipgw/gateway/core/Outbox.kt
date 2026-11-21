package io.voipgw.gateway.core

import android.content.ContentValues
import android.content.Context
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import android.database.sqlite.SQLiteOpenHelper
import io.voipgw.protocol.Identifiers

/** Durable at-least-once queue; event ID and timestamp stay fixed across retries. */
internal class Outbox private constructor(private val app: Context) : SQLiteOpenHelper(
    app, "gateway.db", null, 5,
    // Android's default corruption handler may delete the fence and business records.
    DatabaseErrorHandler { throw SQLiteDatabaseCorruptException("Gateway database requires reconciliation") }
) {
    companion object {
        private var instance: Outbox? = null

        // One helper serializes first open and schema upgrades across service and receivers.
        @Synchronized fun shared(context: Context): Outbox = instance ?: Outbox(context.applicationContext).also { instance = it }
    }

    override fun onConfigure(db: SQLiteDatabase) {
        db.execSQL("PRAGMA synchronous = FULL")
    }

    data class Event(val id: String, val type: String, val payload: String, val createdAt: Long, val attempts: Int)
    override fun onCreate(db: android.database.sqlite.SQLiteDatabase) {
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0)")
        createSmsTables(db)
        createSmsQueueIndex(db)
        addBindingFence(db)
        addBindingReplay(db)
        val legacy = app.getSharedPreferences("credentials", Context.MODE_PRIVATE).all.isNotEmpty() ||
            app.getDatabasePath("command_ledger.db").exists()
        if (legacy) markLegacy(db)
        else db.execSQL("INSERT INTO gateway_binding (singleton, phase) VALUES (1, 'UNBOUND')")
    }
    private fun createSmsTables(db: android.database.sqlite.SQLiteDatabase) {
        db.execSQL("CREATE TABLE sms_command (command_id TEXT PRIMARY KEY, task_id TEXT, payload TEXT NOT NULL, error TEXT)")
        db.execSQL("CREATE TABLE sms_task (task_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, state TEXT NOT NULL, emitted TEXT)")
        db.execSQL("CREATE TABLE sms_part (task_id TEXT NOT NULL, part_index INTEGER NOT NULL, sent INTEGER, delivered INTEGER, PRIMARY KEY(task_id, part_index))")
    }
    private fun createSmsQueueIndex(db: android.database.sqlite.SQLiteDatabase) {
        db.execSQL("CREATE INDEX IF NOT EXISTS sms_task_state_idx ON sms_task(state)")
    }
    override fun onUpgrade(db: android.database.sqlite.SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createSmsTables(db)
        if (oldVersion < 3) createSmsQueueIndex(db)
        if (oldVersion < 4) {
            addBindingFence(db)
            // Pre-fence databases carry neither binding nor revocation provenance.
            markLegacy(db)
        }
        if (oldVersion < 5) addBindingReplay(db)
    }

    private fun markLegacy(db: SQLiteDatabase) {
        db.execSQL("INSERT INTO gateway_binding (singleton, phase) VALUES (1, 'LEGACY')")
    }

    private fun addBindingFence(db: SQLiteDatabase) {
        db.execSQL("""CREATE TABLE gateway_binding (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            phase TEXT NOT NULL CHECK (phase IN ('UNBOUND', 'LEGACY', 'PENDING', 'IDLE', 'OPEN', 'TERMINAL')),
            binding_id TEXT, device_id TEXT, token TEXT, origin TEXT, connection_id TEXT, reason TEXT,
            CHECK ((phase IN ('UNBOUND', 'LEGACY')) = (binding_id IS NULL)),
            CHECK ((phase IN ('IDLE', 'OPEN', 'TERMINAL') AND device_id IS NOT NULL AND token IS NOT NULL AND origin IS NOT NULL)
                OR (phase IN ('UNBOUND', 'LEGACY', 'PENDING') AND device_id IS NULL AND token IS NULL AND origin IS NULL)),
            CHECK ((phase = 'OPEN') = (connection_id IS NOT NULL)),
            CHECK ((phase = 'TERMINAL') = (reason IS NOT NULL))
        )""")
        db.execSQL("ALTER TABLE outbox ADD COLUMN binding_id TEXT")
        db.execSQL("ALTER TABLE sms_command ADD COLUMN binding_id TEXT")
        db.execSQL("ALTER TABLE sms_task ADD COLUMN binding_id TEXT")
        db.execSQL("ALTER TABLE sms_task ADD COLUMN connection_id TEXT")
        db.execSQL("CREATE INDEX outbox_binding_idx ON outbox(binding_id, created_at)")
        db.execSQL("CREATE INDEX sms_task_connection_idx ON sms_task(binding_id, connection_id, state)")
    }
    private fun addBindingReplay(db: SQLiteDatabase) {
        // Existing v4 rows keep NULL replay fields, including legacy PENDING and orphan OPEN.
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_attempt_id TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_bearer TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_origin TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_code TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_manufacturer TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_model TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_api_level INTEGER")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_apk_version TEXT")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_apk_code INTEGER")
        db.execSQL("ALTER TABLE gateway_binding ADD COLUMN replay_locale TEXT")
        db.execSQL("""ALTER TABLE gateway_binding ADD COLUMN replay_version INTEGER CHECK (
            (replay_version IS NULL AND replay_attempt_id IS NULL AND replay_bearer IS NULL
                AND replay_origin IS NULL AND replay_code IS NULL AND replay_manufacturer IS NULL
                AND replay_model IS NULL AND replay_api_level IS NULL AND replay_apk_version IS NULL
                AND replay_apk_code IS NULL AND replay_locale IS NULL)
            OR (replay_version IS NOT NULL AND replay_version = 2 AND phase = 'PENDING'
                AND replay_attempt_id IS NOT NULL AND replay_bearer IS NOT NULL AND replay_origin IS NOT NULL
                AND replay_code IS NOT NULL AND replay_manufacturer IS NOT NULL AND replay_model IS NOT NULL
                AND replay_api_level IS NOT NULL AND replay_apk_version IS NOT NULL
                AND replay_apk_code IS NOT NULL AND replay_locale IS NOT NULL)
        )""")
    }

    fun enqueue(type: String, payload: String, now: Long = System.currentTimeMillis()): String {
        require(type in setOf("sms.received", "sms.result", "call.incoming", "call.state"))
        val id = Identifiers.event(now)
        val values = ContentValues().apply {
            put("id", id); put("type", type); put("payload", payload); put("created_at", now)
            if (type.startsWith("call.")) put("expires_at", now + 60_000L) else putNull("expires_at")
            put("attempts", 0)
        }
        val db = writableDatabase
        db.beginTransaction()
        try {
            // Keep input even while unbound or terminal. An unpromoted binding owns no records.
            val bindingId = db.rawQuery("SELECT binding_id FROM gateway_binding WHERE singleton = 1 AND phase IN ('IDLE', 'OPEN', 'TERMINAL')", null).use {
                if (it.moveToFirst()) it.getString(0) else null
            }
            values.put("binding_id", bindingId)
            db.insertOrThrow("outbox", null, values)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return id
    }
    internal fun pendingHead(bindingId: String, now: Long = System.currentTimeMillis()): Event? {
        val db = writableDatabase
        db.delete("outbox", "binding_id = ? AND expires_at IS NOT NULL AND expires_at <= ?", arrayOf(bindingId, now.toString()))
        return db.query("outbox", arrayOf("id", "type", "payload", "created_at", "attempts"),
            "binding_id = ?", arrayOf(bindingId), null, null, "created_at ASC, rowid ASC", "1").use { cursor ->
            if (cursor.moveToFirst()) Event(cursor.getString(0), cursor.getString(1), cursor.getString(2), cursor.getLong(3), cursor.getInt(4)) else null
        }
    }

    internal fun attempted(bindingId: String, id: String) {
        writableDatabase.execSQL("UPDATE outbox SET attempts = attempts + 1 WHERE binding_id = ? AND id = ?", arrayOf(bindingId, id))
    }

    internal fun acknowledge(bindingId: String, id: String) {
        writableDatabase.delete("outbox", "binding_id = ? AND id = ?", arrayOf(bindingId, id))
    }
}
