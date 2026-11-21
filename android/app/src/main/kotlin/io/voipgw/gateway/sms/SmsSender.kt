package io.voipgw.gateway.sms

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager

/** Low-level adapter. Call only after validation and durable task reservation. */
internal class SmsSender(private val context: Context) {
    enum class Result { PERMISSION_MISSING, SUBSCRIPTION_UNSUPPORTED, PREPARATION_FAILED, NOT_SUBMITTED, SUBMITTED, UNKNOWN }
    fun submit(
        taskId: String, to: String, body: String, subscriptionId: Int?,
        claim: (Int) -> Boolean, dispatch: (() -> Unit) -> Boolean
    ): Result {
        require(taskId.matches(Regex("tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}")))
        require(to.isNotBlank() && body.isNotBlank())
        if (context.checkCallingOrSelfPermission(Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) return Result.PERMISSION_MISSING
        if (Build.VERSION.SDK_INT < 22 && subscriptionId != null) return Result.SUBSCRIPTION_UNSUPPORTED
        if (Build.VERSION.SDK_INT >= 22 && subscriptionId == null) return Result.SUBSCRIPTION_UNSUPPORTED
        return try {
            val manager = if (Build.VERSION.SDK_INT >= 22) SmsManager.getSmsManagerForSubscriptionId(subscriptionId!!) else SmsManager.getDefault()
            val parts = manager.divideMessage(body)
            if (parts.isEmpty()) return Result.PREPARATION_FAILED
            val sent = ArrayList<PendingIntent>(); val delivered = ArrayList<PendingIntent>()
            for (index in parts.indices) {
                sent.add(SmsCallbackReceiver.pending(context, taskId, index, false))
                delivered.add(SmsCallbackReceiver.pending(context, taskId, index, true))
            }
            // Claim failure may be an uncertain commit. Never proceed to the modem.
            val claimed = try { claim(parts.size) } catch (_: Exception) { return Result.UNKNOWN }
            if (!claimed) return Result.NOT_SUBMITTED
            try {
                if (dispatch { manager.sendMultipartTextMessage(to, null, parts, sent, delivered) }) Result.SUBMITTED
                else Result.NOT_SUBMITTED
            } catch (_: Exception) { Result.UNKNOWN }
        } catch (_: Exception) { Result.PREPARATION_FAILED }
    }
}
