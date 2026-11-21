package io.voipgw.gateway.sms

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/** Internal callback identity encodes task, part and callback kind in the intent data URI. */
class SmsCallbackReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "voipgw-sms" || uri.host != "receipt") return
        val segments = uri.pathSegments
        if (segments.size != 3) return
        val taskId = segments[0]
        if (!taskId.matches(Regex("tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        val index = segments[1].toIntOrNull() ?: return
        if (index < 0 || segments[2] !in listOf("sent", "delivered")) return
        val delivery = segments[2] == "delivered"
        // RESULT_OK alone does not prove final carrier delivery. Do not report it
        // until the status-report PDU can be decoded and validated on devices.
        if (delivery) return
        val success = resultCode == Activity.RESULT_OK
        val pending = goAsync()
        val app = context.applicationContext
        Thread {
            try {
                for (attempt in 0 until 3) {
                    try {
                        SmsTaskStore(app).recordPart(taskId, index, delivery, success)
                        io.voipgw.gateway.core.OutboxWake.notifyCommitted()
                        return@Thread
                    } catch (e: Exception) {
                        android.util.Log.e("SmsCallback", "Unable to persist SMS callback, attempt "+ (attempt + 1), e)
                        if (attempt < 2) Thread.sleep(250L * (attempt + 1))
                    }
                }
            } finally { pending.finish() }
        }.start()
    }
    companion object {
        fun pending(context: Context, taskId: String, index: Int, delivery: Boolean): PendingIntent {
            require(taskId.matches(Regex("tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}")) && index >= 0)
            val kind = if (delivery) "delivered" else "sent"
            val data = Uri.Builder().scheme("voipgw-sms").authority("receipt").appendPath(taskId).appendPath(index.toString()).appendPath(kind).build()
            val intent = Intent(context, SmsCallbackReceiver::class.java).setData(data)
            val immutable = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
            return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or immutable)
        }
    }
}
