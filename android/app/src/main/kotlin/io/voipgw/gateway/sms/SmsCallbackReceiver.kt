package io.voipgw.gateway.sms

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/** Handles explicit send callbacks; never interprets them as carrier delivery. */
class SmsCallbackReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val receipt = SmsSendAttempt.parseSentReceipt(intent.dataString ?: return) ?: return
        val evidence = SmsPartEvidence.fromSentResult(resultCode) ?: return
        val pending = goAsync()
        val app = context.applicationContext
        Thread {
            try {
                for (attempt in 0 until 3) {
                    try {
                        SmsTaskStore(app).recordPart(receipt, evidence)
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
        internal fun pending(context: Context, attempt: SmsSendAttempt, index: Int): PendingIntent {
            // Intent extras are not part of PendingIntent identity; keep the claim in data.
            val intent = Intent(context, SmsCallbackReceiver::class.java).setData(Uri.parse(attempt.sentReceiptUri(index)))
            val immutable = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0
            return PendingIntent.getBroadcast(context, 0, intent, immutable)
        }
    }
}
