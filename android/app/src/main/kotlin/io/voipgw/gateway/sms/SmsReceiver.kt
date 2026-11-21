package io.voipgw.gateway.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.telephony.SmsMessage
import io.voipgw.gateway.core.Outbox
import io.voipgw.protocol.SmsParts
import org.json.JSONObject

/** Only processes the system-delivered SMS_RECEIVED broadcast; never sends SMS. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "android.provider.Telephony.SMS_RECEIVED") return
        val extras = intent.extras ?: return
        val pdus = extras.get("pdus") as? Array<*> ?: return
        val format = extras.getString("format")
        val parts = ArrayList<SmsParts.Part>()
        for (raw in pdus) {
            val bytes = raw as? ByteArray ?: return
            val sms = if (Build.VERSION.SDK_INT >= 23) SmsMessage.createFromPdu(bytes, format) else SmsMessage.createFromPdu(bytes)
            if (sms == null) return
            val address = sms.originatingAddress ?: return
            parts.add(SmsParts.Part(address, sms.messageBody ?: return, sms.timestampMillis))
        }
        val message = try { SmsParts.assemble(parts) } catch (_: IllegalArgumentException) { return }
        val payload = JSONObject().put("subId", JSONObject.NULL).put("slot", if (Build.VERSION.SDK_INT < 22) 0 else JSONObject.NULL)
            .put("from", message.from).put("fromKind", "unknown").put("body", message.body)
            .put("receivedAt", message.receivedAt).put("parts", message.parts)
        Outbox.shared(context).enqueue("sms.received", payload.toString())
        io.voipgw.gateway.core.OutboxWake.notifyCommitted()
    }
}
