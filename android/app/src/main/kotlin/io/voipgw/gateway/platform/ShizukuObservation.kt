package io.voipgw.gateway.platform

import android.os.Build

/** Null means a live binder could not be observed, not that the service stopped. */
object ShizukuObservation {
    fun state(context: android.content.Context): String? {
        if (Build.VERSION.SDK_INT < 24) return "unsupported"
        try { context.packageManager.getPackageInfo("moe.shizuku.privileged.api", 0) }
        catch (_: android.content.pm.PackageManager.NameNotFoundException) { return "not_installed" }
        catch (_: RuntimeException) { return null }
        return try { if (ShizukuApi24.pingBinder()) "running" else null } catch (_: RuntimeException) { null } catch (_: LinkageError) { null }
    }
}
