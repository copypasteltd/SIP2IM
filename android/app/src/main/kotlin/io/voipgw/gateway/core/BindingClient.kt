package io.voipgw.gateway.core

import android.content.Context
import android.os.Build
import io.voipgw.protocol.BindingAddress
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import java.io.IOException
import java.net.Proxy
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** Invoked on a worker thread. Activity recreation reuses the same process-wide send guard. */
internal class BindingClient(private val context: Context) {
    private val replay = sharedReplay(context.applicationContext)

    fun isRunning() = replay.isRunning()

    @Suppress("DEPRECATION")
    fun bind(address: String, code: String) = replay.start {
        val origin = BindingAddress.origin(address)
        require(BindingAddress.code(code))
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val metadata = BindingMetadata(Build.MANUFACTURER, Build.MODEL, Build.VERSION.SDK_INT,
            info.versionName ?: "unknown", info.versionCode, Locale.getDefault().toString().replace('_', '-'))
        PendingBinding.create(origin, code, metadata)
    }

    fun resume() = replay.resume()

    private companion object {
        private var shared: BindingReplay? = null

        @Synchronized fun sharedReplay(app: Context): BindingReplay = shared ?: BindingReplay(
            Credentials(app).fence, BindingV2Http::exchange, Credentials::notifyBindingObservers
        ).also { shared = it }
    }
}

internal object BindingV2Http {
    private val json = MediaType.parse("application/json; charset=utf-8")
    private class SendPermit(val used: AtomicBoolean = AtomicBoolean())
    private val http = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .callTimeout(25, TimeUnit.SECONDS)
        .addNetworkInterceptor { chain ->
            // Refuse even HTTP status follow-ups (e.g. 503 with Retry-After: 0).
            val request = chain.request()
            val permit = request.tag() as? SendPermit
            if (permit == null || !permit.used.compareAndSet(false, true)) throw IOException("Binding follow-up blocked")
            chain.proceed(request)
        }
        .build()

    fun request(pending: PendingBinding): Request = Request.Builder()
        .url(pending.origin + "/api/device/bind-v2")
        .header("Authorization", "Bearer " + pending.bearer)
        .header("Cache-Control", "no-store")
        .post(RequestBody.create(json, pending.requestBody()))
        .tag(SendPermit())
        .build()

    fun exchange(pending: PendingBinding): BindingProof? = http.newCall(request(pending)).execute().use(::readProof)

    fun readProof(response: Response): BindingProof? {
        if (response.code() != 200 || !response.cacheControl().noStore()) return null
        val source = response.body()?.source() ?: return null
        if (source.request(BindingProof.MAX_BYTES.toLong() + 1)) return null
        return BindingProof.parse(source.readUtf8())
    }
}
