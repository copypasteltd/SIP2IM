package io.voipgw.gateway.core

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/** Best effort: Android may restrict background foreground-service starts. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (Credentials(context).state() != BindingFence.State.BOUND) return
        try {
            val service = Intent(context, GatewayService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(service) else context.startService(service)
        } catch (e: RuntimeException) {
            Log.e("GatewayBoot", "Unable to restore gateway; open the app to retry", e)
        }
    }
}
