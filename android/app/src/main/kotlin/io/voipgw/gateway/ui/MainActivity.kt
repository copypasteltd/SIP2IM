package io.voipgw.gateway.ui

import android.app.Activity
import android.app.AlertDialog
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import io.voipgw.gateway.R
import io.voipgw.gateway.core.BindingClient
import io.voipgw.gateway.core.BindingFence
import io.voipgw.gateway.core.BindingReplay
import io.voipgw.gateway.core.GatewayStart
import io.voipgw.gateway.core.GatewayConnectionObservation
import io.voipgw.gateway.core.TerminalConnectionObservation
import io.voipgw.gateway.core.Credentials
import io.voipgw.protocol.BindingAddress

class MainActivity : Activity() {
    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private var bindingObserver: (() -> Unit)? = null
    private var bindingResult: ((BindingReplay.Result) -> Unit)? = null
    private var startObserver: (() -> Unit)? = null
    private var connectionObserver: (() -> Unit)? = null

    override fun onDestroy() {
        bindingObserver?.let { Credentials.unregisterBindingObserver(it) }
        bindingObserver = null
        bindingResult = null
        startObserver?.let { GatewayStart.unregister(it) }
        startObserver = null
        connectionObserver?.let { GatewayConnectionObservation.state.unregister(it) }
        connectionObserver = null
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        val credentials = Credentials(this)
        val language = if (credentials.state() == BindingFence.State.BOUND) {
            val ledger = io.voipgw.gateway.core.CommandLedger(this)
            try { ledger.config("locale") } finally { ledger.close() }
        } else null
        if (language != null) {
            val parts = language.split('-')
            val configuration = android.content.res.Configuration(resources.configuration)
            configuration.locale = java.util.Locale(parts[0], parts.getOrElse(1) { "" })
            resources.updateConfiguration(configuration, resources.displayMetrics)
        }
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("gateway", MODE_PRIVATE)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (24 * resources.displayMetrics.density).toInt(); setPadding(pad, pad, pad, pad)
        }
        content.addView(TextView(this).apply { setText(R.string.app_name); textSize = 24f })
        content.addView(TextView(this).apply { setText(R.string.foundation_status); textSize = 16f })
        val status = TextView(this).apply { accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        content.addView(status)
        val startStatus = TextView(this); content.addView(startStatus)
        val connectionStatus = TextView(this); content.addView(connectionStatus)
        val retry = Button(this).apply { setText(R.string.gateway_retry) }; content.addView(retry)
        content.addView(Switch(this).apply {
            setText(R.string.pause_gateway); minHeight = (48 * resources.displayMetrics.density).toInt()
            isChecked = prefs.getBoolean("paused", false)
            setOnCheckedChangeListener { _, checked -> prefs.edit().putBoolean("paused", checked).apply() }
        })
        content.addView(Button(this).apply {
            setText(R.string.sms_permission)
            setOnClickListener {
                if (Build.VERSION.SDK_INT >= 23)
                    requestPermissions(arrayOf(android.Manifest.permission.RECEIVE_SMS, android.Manifest.permission.SEND_SMS, android.Manifest.permission.READ_PHONE_STATE), 100)
            }
        })
        val client = BindingClient(applicationContext)
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val address = EditText(this).apply {
            id = View.generateViewId()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            isSaveEnabled = false
            setSingleLine(true)
        }
        val code = EditText(this).apply {
            id = View.generateViewId()
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            isSaveEnabled = false
            if (Build.VERSION.SDK_INT >= 26) importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        }
        form.addView(TextView(this).apply { setText(R.string.server_address); labelFor = address.id })
        form.addView(address)
        form.addView(TextView(this).apply { setText(R.string.binding_code); labelFor = code.id })
        form.addView(code)
        content.addView(form)
        val button = Button(this).apply { minHeight = (48 * resources.displayMetrics.density).toInt() }
        content.addView(button)
        fun refreshBinding(result: BindingReplay.Result? = null) {
            if (isFinishing || isDestroyed) return
            val state = credentials.state()
            val running = client.isRunning()
            val canStart = state == BindingFence.State.UNBOUND
            val canResume = state == BindingFence.State.PENDING_REPLAY
            form.visibility = if (canStart) View.VISIBLE else View.GONE
            address.isEnabled = canStart && !running
            code.isEnabled = canStart && !running
            if (!canStart) code.text.clear()
            button.visibility = if (canStart || canResume) View.VISIBLE else View.GONE
            button.isEnabled = !running && (canStart || canResume)
            button.setText(if (canResume) R.string.binding_resume else R.string.bind)
            when {
                running -> status.setText(R.string.binding_progress)
                canResume -> status.setText(if (result == BindingReplay.Result.BACKOFF) R.string.binding_retry_later else R.string.binding_outcome_unknown)
                state == BindingFence.State.RECONCILIATION -> status.setText(R.string.binding_pending)
                state == BindingFence.State.BOUND -> status.setText(R.string.binding_existing)
                state == BindingFence.State.TERMINAL -> status.text = ""
                result == BindingReplay.Result.INVALID -> status.setText(R.string.binding_failed)
                else -> status.text = ""
            }
        }
        val refreshStart = {
            if (!isFinishing && !isDestroyed) {
                val bound = credentials.state() == BindingFence.State.BOUND
                val state = GatewayStart.current()
                startStatus.setText(if (!bound) R.string.gateway_start_unknown else when (state) {
                    GatewayStart.State.UNKNOWN -> R.string.gateway_start_unknown
                    GatewayStart.State.REQUESTING -> R.string.gateway_start_requesting
                    GatewayStart.State.ACCEPTED -> R.string.gateway_start_requested
                    GatewayStart.State.FAILED -> R.string.gateway_start_failed
                })
                retry.visibility = if (bound && GatewayConnectionObservation.state.current() != TerminalConnectionObservation.State.TERMINAL_CLOSED && (state == GatewayStart.State.FAILED || state == GatewayStart.State.ACCEPTED)) android.view.View.VISIBLE else android.view.View.GONE
            }
        }
        startObserver = { mainHandler.post { refreshStart() }; Unit }.also { GatewayStart.register(it) }
        val refreshConnection = {
            if (!isFinishing && !isDestroyed) {
                val closed = credentials.state() == BindingFence.State.TERMINAL ||
                    GatewayConnectionObservation.state.current() == TerminalConnectionObservation.State.TERMINAL_CLOSED
                connectionStatus.setText(if (closed) R.string.gateway_connection_terminal_closed else R.string.gateway_connection_unknown)
            }
        }
        bindingObserver = { mainHandler.post { refreshBinding(); refreshConnection(); refreshStart() }; Unit }
            .also { Credentials.registerBindingObserver(it) }
        connectionObserver = { mainHandler.post { refreshConnection(); refreshStart() }; Unit }
            .also { GatewayConnectionObservation.state.register(it) }
        refreshConnection()
        refreshBinding()
        retry.setOnClickListener { GatewayStart.request(applicationContext, retry = true) }
        refreshStart()
        if (credentials.state() == BindingFence.State.BOUND) GatewayStart.request(applicationContext)
        bindingResult = ::refreshBinding
        val app = applicationContext
        val activity = java.lang.ref.WeakReference(this)
        val handler = mainHandler
        fun runBinding(action: () -> BindingReplay.Result) {
            button.isEnabled = false
            status.setText(R.string.binding_progress)
            Thread {
                val result = try { action() } catch (_: Exception) { BindingReplay.Result.UNCERTAIN }
                if (result == BindingReplay.Result.SUCCESS) GatewayStart.request(app)
                handler.post { activity.get()?.bindingResult?.invoke(result) }
            }.start()
        }
        button.setOnClickListener {
            when (credentials.state()) {
                BindingFence.State.PENDING_REPLAY -> runBinding(client::resume)
                BindingFence.State.UNBOUND -> {
                    val origin = try { BindingAddress.origin(address.text.toString()) } catch (_: Exception) { null }
                    val value = code.text.toString()
                    if (origin == null || !BindingAddress.code(value)) {
                        refreshBinding(BindingReplay.Result.INVALID)
                        return@setOnClickListener
                    }
                    AlertDialog.Builder(this)
                        .setTitle(R.string.binding_confirm_title)
                        .setMessage(getString(R.string.binding_confirm_message, origin))
                        .setNegativeButton(android.R.string.cancel, null)
                        .setPositiveButton(R.string.binding_confirm_submit) { _, _ -> runBinding { client.bind(origin, value) } }
                        .show()
                }
                else -> refreshBinding()
            }
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }
}
