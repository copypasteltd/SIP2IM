package io.voipgw.gateway.platform

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject

/** Null means no reliable SIM inventory, not evidence of an absent SIM. */
object SimSnapshot {
    fun observe(context: Context): JSONArray? {
        if (context.checkCallingOrSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return null
        return try {
            if (Build.VERSION.SDK_INT < 22) {
                val phone = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return null
                val state = when (phone.simState) {
                    TelephonyManager.SIM_STATE_READY -> "ready"
                    TelephonyManager.SIM_STATE_ABSENT -> "absent"
                    TelephonyManager.SIM_STATE_PIN_REQUIRED, TelephonyManager.SIM_STATE_PUK_REQUIRED, TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "locked"
                    else -> "unknown"
                }
                JSONArray().put(item(0, null, state))
            } else {
                val manager = SubscriptionManager.from(context)
                val subscriptions = manager.activeSubscriptionInfoList ?: return null
                // Empty active list cannot establish whether SIMs are absent or merely unavailable.
                if (subscriptions.isEmpty()) return null
                val result = JSONArray()
                for (sub in subscriptions) {
                    if (sub.simSlotIndex < 0 || sub.subscriptionId < 0) return null
                    val phone = context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager ?: return null
                    val observed = if (Build.VERSION.SDK_INT >= 26) phone.getSimState(sub.simSlotIndex) else if (subscriptions.size == 1 && sub.simSlotIndex == 0) phone.simState else TelephonyManager.SIM_STATE_UNKNOWN
                    val state = when (observed) {
                        TelephonyManager.SIM_STATE_READY -> "ready"
                        TelephonyManager.SIM_STATE_ABSENT -> "absent"
                        TelephonyManager.SIM_STATE_PIN_REQUIRED, TelephonyManager.SIM_STATE_PUK_REQUIRED, TelephonyManager.SIM_STATE_NETWORK_LOCKED -> "locked"
                        else -> "unknown"
                    }
                    result.put(item(sub.simSlotIndex, sub.subscriptionId, state))
                }
                result
            }
        } catch (_: SecurityException) { null } catch (_: RuntimeException) { null }
    }
    private fun item(slot: Int, subId: Int?, state: String) = JSONObject()
        .put("slot", slot).put("subId", subId ?: JSONObject.NULL).put("state", state)
        .put("carrier", JSONObject.NULL).put("reportedNumber", JSONObject.NULL)
        .put("mcc", JSONObject.NULL).put("mnc", JSONObject.NULL)
}
