package io.voipgw.gateway.platform

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.os.BatteryManager
import org.json.JSONObject

/** Preserve unknown observations without suppressing liveness. Requires updated core schema. */
object HeartbeatObservation {
    fun payload(context: Context): JSONObject? {
        val shizuku = io.voipgw.protocol.HeartbeatState.observed(ShizukuObservation.state(context))
        val network = try {
            val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val info = manager?.activeNetworkInfo
            when {
                manager == null -> "unknown"
                info == null || !info.isConnected -> "none"
                info.type == ConnectivityManager.TYPE_WIFI -> "wifi"
                info.type == ConnectivityManager.TYPE_MOBILE -> "cellular"
                else -> "unknown"
            }
        } catch (_: RuntimeException) { "unknown" }
        val battery = io.voipgw.protocol.HeartbeatState.optionalObservation { context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val percent = if (level >= 0 && scale > 0 && level <= scale) (100L * level / scale).toInt() else null
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val charging = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
            else -> null
        }
        return JSONObject().put("battery", percent ?: JSONObject.NULL).put("charging", charging ?: JSONObject.NULL)
            .put("network", network).put("signalDbm", JSONObject.NULL).put("shizuku", shizuku)
            .put("paused", context.getSharedPreferences("gateway", Context.MODE_PRIVATE).getBoolean("paused", false))
    }
}
