package io.voipgw.gateway.core

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** Durable cached command acknowledgments. This ledger alone does not authorize side effects. */
class CommandLedger(context: Context) : SQLiteOpenHelper(context.applicationContext, "command_ledger.db", null, 3) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE acknowledgments (id TEXT PRIMARY KEY, error TEXT NOT NULL, created INTEGER NOT NULL, command_type TEXT, payload TEXT)")
        db.execSQL("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 3) db.execSQL("CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE acknowledgments ADD COLUMN command_type TEXT")
            db.execSQL("ALTER TABLE acknowledgments ADD COLUMN payload TEXT")
        }
    }
    fun config(key: String): String? = readableDatabase.query("config", arrayOf("value"), "key = ?", arrayOf(key), null, null, null).use { if (it.moveToFirst()) it.getString(0) else null }
    @Synchronized fun applyConfig(values: Map<String, String>) {
        val db = writableDatabase
        db.beginTransaction()
        try { writeConfig(db, values); db.setTransactionSuccessful() } finally { db.endTransaction() }
    }
    private fun writeConfig(db: SQLiteDatabase, values: Map<String, String>) {
        for ((key, value) in values) db.insertWithOnConflict("config", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE)
    }
    @Synchronized fun rememberConfig(id: String, payload: String, error: String, values: Map<String, String>): String {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val inserted = db.insertWithOnConflict("acknowledgments", null, ContentValues().apply {
                put("id", id); put("error", error); put("created", System.currentTimeMillis()); put("command_type", "config.update"); put("payload", payload)
            }, SQLiteDatabase.CONFLICT_IGNORE) != -1L
            val result = db.query("acknowledgments", arrayOf("error", "command_type", "payload"), "id = ?", arrayOf(id), null, null, null).use {
                check(it.moveToFirst()); if (it.getString(1) != "config.update" || it.getString(2) != payload) "CONFLICT" else it.getString(0)
            }
            if (inserted && result.isEmpty()) writeConfig(db, values)
            db.execSQL("DELETE FROM acknowledgments WHERE rowid NOT IN (SELECT rowid FROM acknowledgments ORDER BY rowid DESC LIMIT 500)")
            db.setTransactionSuccessful(); return result
        } finally { db.endTransaction() }
    }
    @Synchronized fun rememberTyped(id: String, type: String, payload: String, error: String): String {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.insertWithOnConflict("acknowledgments", null, ContentValues().apply {
                put("id", id); put("error", error); put("created", System.currentTimeMillis())
                put("command_type", type); put("payload", payload)
            }, SQLiteDatabase.CONFLICT_IGNORE)
            val result = db.query("acknowledgments", arrayOf("error", "command_type", "payload"), "id = ?", arrayOf(id), null, null, null).use {
                check(it.moveToFirst())
                if (it.getString(1) != type || it.getString(2) != payload) "CONFLICT" else it.getString(0)
            }
            db.execSQL("DELETE FROM acknowledgments WHERE rowid NOT IN (SELECT rowid FROM acknowledgments ORDER BY rowid DESC LIMIT 500)")
            db.setTransactionSuccessful()
            return result
        } finally { db.endTransaction() }
    }
    @Synchronized fun remember(id: String, error: String): String {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.insertWithOnConflict("acknowledgments", null, ContentValues().apply {
                put("id", id); put("error", error); put("created", System.currentTimeMillis())
            }, SQLiteDatabase.CONFLICT_IGNORE)
            val saved = db.query("acknowledgments", arrayOf("error"), "id = ?", arrayOf(id), null, null, null).use {
                check(it.moveToFirst()); it.getString(0)
            }
            db.execSQL("DELETE FROM acknowledgments WHERE rowid NOT IN (SELECT rowid FROM acknowledgments ORDER BY rowid DESC LIMIT 500)")
            db.setTransactionSuccessful()
            return saved
        } finally { db.endTransaction() }
    }
}
