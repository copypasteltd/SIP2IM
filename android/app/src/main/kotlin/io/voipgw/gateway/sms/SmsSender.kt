package io.voipgw.gateway.sms

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager

/** Low-level adapter. Call only after validation and durable task reservation. */
internal class SmsSender(private val context: Context) {
    enum class Result(val queuedError: String? = null) {
        PERMISSION_MISSING("SMS_PERMISSION_MISSING"), DEVICE_UNSUPPORTED("CAPABILITY_UNSUPPORTED"),
        SUBSCRIPTION_UNSUPPORTED("SIM_NOT_READY"), PREPARATION_FAILED("INTERNAL"),
        NOT_SUBMITTED, SUBMITTED, UNKNOWN
    }

    fun unavailable(): Result? = preflight(
        context.checkCallingOrSelfPermission(Manifest.permission.SEND_SMS) == PackageManager.PERMISSION_GRANTED
    ) {
        val feature = if (Build.VERSION.SDK_INT >= 33) PackageManager.FEATURE_TELEPHONY_MESSAGING
            else PackageManager.FEATURE_TELEPHONY
        context.packageManager.hasSystemFeature(feature)
    }

    fun submit(
        attempt: SmsSendAttempt, to: String, body: String, subscriptionId: Int?,
        claim: (Int) -> Boolean, dispatch: (() -> Unit) -> Boolean
    ): Result {
        require(to.isNotBlank() && body.isNotBlank())
        unavailable()?.let { return it }
        if (!supportsSubscription(Build.VERSION.SDK_INT, subscriptionId)) return Result.SUBSCRIPTION_UNSUPPORTED
        return try {
            val manager = if (Build.VERSION.SDK_INT >= 22) SmsManager.getSmsManagerForSubscriptionId(subscriptionId!!) else SmsManager.getDefault()
            val parts = manager.divideMessage(body)
            if (parts.isEmpty()) return Result.PREPARATION_FAILED
            val sent = ArrayList<PendingIntent>(parts.size)
            for (index in parts.indices) sent.add(SmsCallbackReceiver.pending(context, attempt, index))
            // Claim failure may be an uncertain commit. Never proceed to the modem.
            val claimed = try { claim(parts.size) } catch (_: Exception) { return Result.UNKNOWN }
            if (!claimed) return Result.NOT_SUBMITTED
            try {
                if (dispatch { manager.sendMultipartTextMessage(to, null, parts, sent, null) }) Result.SUBMITTED
                else Result.NOT_SUBMITTED
            } catch (_: Exception) { Result.UNKNOWN }
        } catch (_: SecurityException) {
            Result.PERMISSION_MISSING
        } catch (_: UnsupportedOperationException) {
            Result.DEVICE_UNSUPPORTED
        } catch (_: Exception) {
            Result.PREPARATION_FAILED
        }
    }

    companion object {
        internal fun supportsSubscription(api: Int, subscriptionId: Int?): Boolean =
            if (api < 22) subscriptionId == null else subscriptionId != null && subscriptionId >= 0

        internal fun preflight(hasPermission: Boolean, supportsSms: () -> Boolean): Result? = when {
            !hasPermission -> Result.PERMISSION_MISSING
            !supportsSms() -> Result.DEVICE_UNSUPPORTED
            else -> null
        }
    }
}
