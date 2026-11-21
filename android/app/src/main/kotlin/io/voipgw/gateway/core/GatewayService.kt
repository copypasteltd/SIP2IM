package io.voipgw.gateway.core

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import io.voipgw.gateway.R
import io.voipgw.gateway.platform.ApiLevel
import io.voipgw.gateway.platform.SimSnapshot
import io.voipgw.gateway.platform.HeartbeatObservation
import io.voipgw.gateway.sms.SmsSendAttempt
import io.voipgw.gateway.sms.SmsTaskStore
import io.voipgw.gateway.sms.SmsSender
import android.Manifest
import android.content.pm.PackageManager
import android.telephony.TelephonyManager
import android.telephony.SubscriptionManager
import io.voipgw.protocol.Identifiers
import io.voipgw.protocol.OutboxPacer
import io.voipgw.protocol.SimReadiness
import io.voipgw.protocol.ConfigUpdate
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.TimeUnit

/** Foreground connection and durable SMS command routing. */
class GatewayService : Service() {
    companion object { const val ACTION_INITIAL_BIND = "io.voipgw.gateway.INITIAL_BIND" }
    private val handler = Handler(Looper.getMainLooper())
    private val lifecycle = LifecycleGate()
    private val connectionLock = Any()
    private lateinit var observationToken: Any
    private var wakeRegistered = false
    private var pauseRegistered = false
    private val client = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).followRedirects(false).build()
    private var socket: WebSocket? = null
    private var session: Session? = null
    private var reconnects = 0
    private var reconnectTicket = 0L
    @Volatile private var terminal = false
    private var connectionAttempted = false
    @Volatile private var stopped = false
    private lateinit var credentials: Credentials
    private lateinit var execution: GatewayExecution
    private lateinit var outbox: Outbox
    private lateinit var commandLedger: CommandLedger
    private lateinit var smsStore: SmsTaskStore
    private val pacer = OutboxPacer()

    private inner class Session(val connection: BindingConnection) {
        val bindingId get() = connection.identity.id
        var helloDeadline: HelloDeadline? = null
        val drain = CooperativeDrain(
            post = { task -> handler.post { lifecycle.run { task.run() } }; Unit },
            stopped = { stopped || !execution.isReady(connection) },
            paused = ::locallyPaused,
            boundary = { smsStore.queueBoundary(connection) },
            page = { after, boundary -> smsStore.queuePage(connection, after, boundary, 32) },
            key = { it.rowId },
            process = { row -> processSms(this, row.taskId, row.payload) }
        )
    }

    private val outboxWake: () -> Unit = {
        handler.post { lifecycle.run { withCurrentSocket { active, ws -> flushNext(active, ws) } } }
    }
    private var lastSnapshotState: String? = null
    private var lastSnapshotAckAt = 0L
    private var pendingSnapshotId: String? = null
    private var pendingSnapshotAt = 0L
    private val pauseListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "paused") rescheduleHeartbeat()
    }
    private val heartbeat = object : Runnable {
        override fun run() = lifecycle.run heartbeatWork@{
            if (stopped || terminal) return@heartbeatWork
            withCurrentSocket { active, ws ->
                try {
                    execution.runReady(active.connection, { false }) {
                        refreshStatus(ws)
                        flushNext(active, ws)
                        if (execution.isReady(active.connection)) {
                            HeartbeatObservation.payload(this@GatewayService)?.let { check(sendOn(ws, "heartbeat", it)) }
                            active.drain.wake()
                        }
                        Unit
                    }
                } catch (_: RuntimeException) { cancelConnection(active, ws) }
            }
            if (!stopped && !terminal) handler.postDelayed(this, (commandLedger.config("heartbeatSec")?.toLongOrNull() ?: 30L) * 1000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        observationToken = GatewayConnectionObservation.state.beginInstance()
        try {
            credentials = Credentials(this)
            execution = GatewayExecution(credentials.fence)
            outbox = Outbox.shared(this)
            commandLedger = CommandLedger(this)
            smsStore = SmsTaskStore(this)
            val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel("gateway", getString(R.string.app_name), NotificationManager.IMPORTANCE_LOW))
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, "gateway") else Notification.Builder(this)
            startForeground(1, builder.setContentTitle(getString(R.string.app_name)).setContentText(getString(R.string.foundation_status)).setSmallIcon(android.R.drawable.stat_notify_sync).build())
            OutboxWake.register(outboxWake); wakeRegistered = true
            getSharedPreferences("gateway", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(pauseListener); pauseRegistered = true
        } catch (failure: Throwable) {
            stopResources()
            throw failure
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        var admitted = false
        lifecycle.run {
            synchronized(connectionLock) {
                if (!stopped && !terminal && credentials.state() == BindingFence.State.BOUND) {
                    if (!connectionAttempted && session == null) connect()
                    admitted = !terminal && credentials.state() == BindingFence.State.BOUND
                }
            }
        }
        if (!admitted) stopSelf(startId)
        return if (admitted) START_STICKY else START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // Caller holds connectionLock. Publish the socket before listeners enter the lock.
    private fun connect() {
        if (stopped || terminal || session != null) return
        val connection = execution.open()
        if (connection == null) {
            Credentials.notifyBindingObservers()
            stopSelf()
            return
        }
        val active = Session(connection)
        session = active
        connectionAttempted = true
        try {
            val origin = connection.identity.origin
            val url = "ws://" + origin.removePrefix("http://") + "/ws/device"
            socket = client.newWebSocket(Request.Builder().url(url).build(), listener(active))
        } catch (_: RuntimeException) {
            finishConnection(active)
        }
    }

    private fun listener(active: Session) = object : WebSocketListener() {
        private fun current(ws: WebSocket, block: () -> Unit) {
            lifecycle.run {
                synchronized(connectionLock) {
                    if (!stopped && session === active && socket === ws) block()
                }
            }
        }

        override fun onOpen(webSocket: WebSocket, response: Response) = current(webSocket) {
            if (active.connection.disconnected || active.helloDeadline != null) return@current
            try {
                val deadline = HelloDeadline(
                    now = android.os.SystemClock::elapsedRealtime,
                    postDelayed = { task, delay -> handler.postDelayed(task, delay) },
                    removeCallbacks = { handler.removeCallbacks(it) },
                    withCurrent = { work -> current(webSocket, work) },
                    onExpired = { retireHandshake(active, webSocket) },
                )
                active.helloDeadline = deadline
                if (!deadline.arm()) return@current
                val info = packageManager.getPackageInfo(packageName, 0)
                if (!deadline.allowsReply()) return@current
                check(sendOn(webSocket, "hello", JSONObject().put("token", active.connection.identity.token)
                    .put("apkVersion", info.versionName ?: "unknown").put("apkCode", info.versionCode)
                    .put("protocol", 1).put("manufacturer", Build.MANUFACTURER).put("model", Build.MODEL)
                    .put("apiLevel", Build.VERSION.SDK_INT).put("locale", Locale.getDefault().toString().replace('_', '-'))))
            } catch (_: Exception) { retireHandshake(active, webSocket) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) = current(webSocket) {
            if (active.connection.disconnected) return@current
            try {
                val msg = JSONObject(text)
                if (msg.getInt("v") != 1) return@current
                val type = msg.getString("type")
                if (type == "hello.ok") {
                    handleHello(active, webSocket, msg.optJSONObject("payload"))
                    return@current
                }
                val payload = msg.getJSONObject("payload")
                execution.runReady(active.connection, { false }) {
                    when (type) {
                        "ack" -> {
                            val ref = payload.getString("refId")
                            val ok = payload.optBoolean("ok", false)
                            if (ref == pendingSnapshotId) {
                                pendingSnapshotId = null
                                if (ok) lastSnapshotAckAt = android.os.SystemClock.elapsedRealtime() else lastSnapshotState = null
                            }
                            acknowledgeAndFlush(active, webSocket, ref, ok)
                        }
                        "sms.send" -> handleSms(active, webSocket, msg.optString("id"), payload)
                        "config.update" -> handleConfig(webSocket, msg.optString("id"), payload)
                        "probe.run" -> handleProbe(webSocket, msg.optString("id"), payload)
                        "call.reject", "call.hangup" -> handleUnsupportedCall(webSocket, msg.optString("id"), type, payload)
                        "call.dial", "call.answer", "call.dtmf" -> handleUnsupportedMediaCall(webSocket, msg.optString("id"), type, payload)
                    }
                    Unit
                }
            } catch (_: Exception) { cancelConnection(active, webSocket) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            active.connection.observeDisconnect()
            current(webSocket) { finishConnection(active) }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            active.connection.observeDisconnect(GatewayExecution.terminalReason(code))
            current(webSocket) { finishConnection(active) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            active.connection.observeDisconnect(GatewayExecution.terminalReason(code))
            current(webSocket) { finishConnection(active) }
            try { webSocket.close(code, null) } catch (_: RuntimeException) { webSocket.cancel() }
        }
    }

    private fun handleHello(active: Session, ws: WebSocket, payload: JSONObject?) {
        val deadline = active.helloDeadline ?: return retireHandshake(active, ws)
        if (!deadline.allowsReply()) return
        val hello = execution.hello(active.connection, payload?.opt("deviceId")) {
            val values = configValues(checkNotNull(payload).getJSONObject("config"))
            require(ConfigUpdate.error(values) == null && values.containsKey("heartbeatSec") && values.containsKey("locale"))
            commandLedger.applyConfig(values.mapValues { it.value.toString() })
            lastSnapshotState = null; lastSnapshotAckAt = 0; pendingSnapshotId = null
            // SIM inventory and SMS permission observations are independent.
            refreshStatus(ws)
        }
        when (hello) {
            GatewayExecution.Hello.ACCEPTED -> {
                deadline.accepted()
                reconnects = 0
                rescheduleHeartbeat()
                flushNext(active, ws)
            }
            GatewayExecution.Hello.DUPLICATE -> Unit
            GatewayExecution.Hello.IDENTITY_MISMATCH, GatewayExecution.Hello.STALE -> cancelConnection(active, ws)
        }
    }

    private fun refreshStatus(ws: WebSocket): Boolean {
        val sims = SimSnapshot.observe(this) ?: JSONArray()
        val permissions = JSONArray()
        for (name in arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.SEND_SMS, Manifest.permission.READ_PHONE_STATE))
            permissions.put(JSONObject().put("name", name).put("granted", checkCallingOrSelfPermission(name) == PackageManager.PERMISSION_GRANTED))
        val key = sims.toString() + permissions.toString()
        val now = android.os.SystemClock.elapsedRealtime()
        if (pendingSnapshotId != null && key == lastSnapshotState && now - pendingSnapshotAt < 10000) return true
        if (pendingSnapshotId == null && key == lastSnapshotState && lastSnapshotAckAt > 0 && now - lastSnapshotAckAt < 3600000) return true
        val probes = JSONObject()
        for (name in arrayOf("smsSend", "smsReceive", "dial", "answer", "hangup", "dtmf", "downlink", "uplink", "earlyMedia"))
            probes.put(name, JSONObject().put("result", "untested").put("probedAt", System.currentTimeMillis()).put("detail", JSONObject.NULL))
        val id = Identifiers.event()
        val frame = envelope("status.snapshot", JSONObject().put("sims", sims).put("simsAuthoritative", false).put("capabilityLevel", ApiLevel.tier(Build.VERSION.SDK_INT)).put("probes", probes).put("permissions", permissions), id)
        check(ws.send(frame.toString()))
        lastSnapshotState = key; pendingSnapshotId = id; pendingSnapshotAt = now
        return true
    }
    private fun handleProbe(ws: WebSocket, id: String, payload: JSONObject) {
        if (!id.matches(Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        val items = payload.optJSONArray("items")
        val valid = items != null && (0 until items.length()).all { items.opt(it) is String }
        val error = if (valid) "CAPABILITY_UNSUPPORTED" else "BAD_MESSAGE"
        val canonical = canonicalJson(payload).toString()
        val saved = commandLedger.rememberTyped(id, "probe.run", canonical, error)
        sendOn(ws, "ack", JSONObject().put("refId", id).put("ok", false).put("error", saved))
    }
    private fun handleUnsupportedCall(ws: WebSocket, id: String, type: String, payload: JSONObject) {
        if (!id.matches(Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        val call = payload.opt("callId") as? String
        val generation = payload.opt("generation")
        val validGeneration = !payload.has("generation") ||
            (generation is String && generation.matches(Regex("gen_[0-7][0-9A-HJKMNP-TV-Z]{25}")))
        val error = if (validGeneration) io.voipgw.protocol.UnsupportedCallCommand.error(call) else "BAD_MESSAGE"
        val canonical = canonicalJson(payload).toString()
        val saved = commandLedger.rememberTyped(id, type, canonical, error)
        sendOn(ws, "ack", JSONObject().put("refId", id).put("ok", false).put("error", saved))
    }
    // Decode without org.json coercions so validation sees the actual source types.
    private fun jsonValue(value: Any?, depth: Int = 0): Any? {
        require(depth <= 64) { "JSON nesting too deep" }
        return when (value) {
            null, JSONObject.NULL -> null
            is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.opt(it), depth + 1) }
            is JSONArray -> (0 until value.length()).map { jsonValue(value.opt(it), depth + 1) }
            else -> value
        }
    }

    // Include all fields, including malformed values and optional generation, in duplicate identity.
    private fun canonicalJson(value: Any?, depth: Int = 0): Any {
        require(depth <= 64) { "JSON nesting too deep" }
        return when (value) {
            null, JSONObject.NULL -> JSONObject.NULL
            is JSONObject -> JSONObject().also { result ->
                for (key in value.keys().asSequence().toList().sorted()) result.put(key, canonicalJson(value.opt(key), depth + 1))
            }
            is JSONArray -> JSONArray().also { result ->
                for (index in 0 until value.length()) result.put(canonicalJson(value.opt(index), depth + 1))
            }
            else -> value
        }
    }

    private fun handleUnsupportedMediaCall(ws: WebSocket, id: String, type: String, payload: JSONObject) {
        if (!id.matches(Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        @Suppress("UNCHECKED_CAST")
        val values = jsonValue(payload) as Map<String, Any?>
        val valid = io.voipgw.protocol.CommandValidation.valid(id, type, values)
        val paused = getSharedPreferences("gateway", MODE_PRIVATE).getBoolean("paused", false)
        val error = when {
            !valid -> "BAD_MESSAGE"
            paused && (type == "call.dial" || type == "call.answer") -> "DEVICE_DISABLED"
            else -> "CAPABILITY_UNSUPPORTED"
        }
        val saved = commandLedger.rememberTyped(id, type, canonicalJson(payload).toString(), error)
        sendOn(ws, "ack", JSONObject().put("refId", id).put("ok", false).put("error", saved))
    }

    private fun rescheduleHeartbeat() {
        handler.post { if (!stopped && !terminal) { handler.removeCallbacks(heartbeat); handler.post(heartbeat) } }
    }
    private fun configValues(payload: JSONObject): Map<String, Any?> {
        val values = mutableMapOf<String, Any?>()
        val keys = payload.keys()
        while (keys.hasNext()) { val key = keys.next(); values[key] = if (payload.isNull(key)) null else payload.opt(key) }
        return values
    }
    private fun handleConfig(ws: WebSocket, id: String, payload: JSONObject) {
        if (!id.matches(Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        val values = mutableMapOf<String, Any?>()
        val keys = payload.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            values[key] = if (payload.isNull(key)) null else payload.opt(key)
        }
        // Cache both a no-op success and rejections before acknowledging duplicates.
        val canonical = JSONObject()
        for (key in values.keys.sorted()) canonical.put(key, values[key] ?: JSONObject.NULL)
        val saved = commandLedger.rememberConfig(id, canonical.toString(), ConfigUpdate.error(values) ?: "", values.mapValues { it.value.toString() })
        if (saved.isEmpty()) rescheduleHeartbeat()
        sendOn(ws, "ack", JSONObject().put("refId", id).put("ok", saved.isEmpty()).put("error", if (saved.isEmpty()) JSONObject.NULL else saved))
    }
    private fun simReadiness(slot: Int, subId: Int?): SimReadiness.State {
        if (checkCallingOrSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) return SimReadiness.State.UNAVAILABLE
        return try {
            val phone = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager ?: return SimReadiness.State.UNKNOWN
            if (slot < 0 || (Build.VERSION.SDK_INT < 22 && (slot != 0 || subId != null)) ||
                (Build.VERSION.SDK_INT >= 22 && (subId == null || subId < 0))) return SimReadiness.State.UNAVAILABLE
            val simState = if (Build.VERSION.SDK_INT >= 26) phone.getSimState(slot) else if (slot == 0) phone.simState else TelephonyManager.SIM_STATE_UNKNOWN
            val card = when (simState) {
                TelephonyManager.SIM_STATE_READY -> SimReadiness.Card.READY
                TelephonyManager.SIM_STATE_ABSENT -> SimReadiness.Card.ABSENT
                TelephonyManager.SIM_STATE_PIN_REQUIRED, TelephonyManager.SIM_STATE_PUK_REQUIRED, TelephonyManager.SIM_STATE_NETWORK_LOCKED -> SimReadiness.Card.LOCKED
                else -> SimReadiness.Card.OTHER
            }
            val matches = if (Build.VERSION.SDK_INT < 22) true else {
                val active = SubscriptionManager.from(this).activeSubscriptionInfoList
                SimReadiness.subscriptionMatch(slot, subId!!, active?.map { it.simSlotIndex to it.subscriptionId })
            }
            SimReadiness.decide(card, matches)
        } catch (_: RuntimeException) { SimReadiness.State.UNKNOWN }
    }
    private fun handleSms(active: Session, ws: WebSocket, id: String, payload: JSONObject) {
        if (!id.matches(Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}"))) return
        val task = payload.opt("taskId") as? String ?: ""
        val slotValue = payload.opt("slot")
        val subValue = payload.opt("subId")
        val to = payload.opt("to") as? String ?: ""
        val body = payload.opt("body") as? String ?: ""
        val slot = (slotValue as? Int) ?: -1
        val sub = subValue as? Int
        val valid = task.matches(Regex("tsk_[0-7][0-9A-HJKMNP-TV-Z]{25}")) && slotValue is Int &&
            payload.has("subId") && (subValue === JSONObject.NULL || subValue is Int) && to.isNotBlank() && body.isNotBlank()
        // Canonical field order gives duplicate commands stable identity independent of JSON key order.
        val canonical = if (valid) JSONObject().put("taskId", task).put("slot", slot).put("subId", sub ?: JSONObject.NULL).put("to", to).put("body", body).toString() else payload.toString()
        val error = when {
            !valid -> "BAD_MESSAGE"
            getSharedPreferences("gateway", MODE_PRIVATE).getBoolean("paused", false) -> "DEVICE_DISABLED"
            else -> SmsSender(this).unavailable()?.queuedError
                ?: if (simReadiness(slot, sub) == SimReadiness.State.UNAVAILABLE) "SIM_NOT_READY" else null
        }
        val ack = smsStore.reserve(active.connection, id, task, canonical, error) ?: return
        val response = JSONObject().put("refId", id).put("ok", ack.error == null).put("error", ack.error ?: JSONObject.NULL)
        check(sendOn(ws, "ack", response))
        if (ack.newlyReserved) handler.post { lifecycle.run { active.drain.wake() } }
    }

    private fun locallyPaused() = getSharedPreferences("gateway", MODE_PRIVATE).getBoolean("paused", false)

    /** Each claim and final submission rechecks the exact connection and local pause. */
    private fun processSms(active: Session, task: String, raw: String) {
        if (!execution.isReady(active.connection) || locallyPaused()) return
        try {
            val payload = JSONObject(raw)
            val sub = if (payload.isNull("subId")) null else payload.getInt("subId")
            val sender = SmsSender(this)
            // A definite SMS denial is not an indeterminate SIM observation.
            sender.unavailable()?.queuedError?.let { error ->
                withSmsAuthority(active) { smsStore.failQueued(active.connection, task, error) }
                return
            }
            when (simReadiness(payload.getInt("slot"), sub)) {
                SimReadiness.State.UNKNOWN -> return
                SimReadiness.State.UNAVAILABLE -> {
                    withSmsAuthority(active) { smsStore.failQueued(active.connection, task, "SIM_NOT_READY") }
                    return
                }
                SimReadiness.State.READY -> Unit
            }
            val attempt = SmsSendAttempt(task, active.bindingId, active.connection.generation)
            val result = sender.submit(
                attempt, payload.getString("to"), payload.getString("body"), sub,
                claim = { count -> claimSms(active, task, count) },
                dispatch = { send -> withSmsAuthority(active, send) != null }
            )
            val error = when (result) {
                SmsSender.Result.NOT_SUBMITTED, SmsSender.Result.SUBMITTED, SmsSender.Result.UNKNOWN -> return
                else -> checkNotNull(result.queuedError)
            }
            withSmsAuthority(active) { smsStore.failQueued(active.connection, task, error) }
        } catch (_: Exception) {
            // The conditional update cannot overwrite a committed claim.
            try { withSmsAuthority(active) { smsStore.failQueued(active.connection, task, "INTERNAL") } } catch (_: Exception) { }
        }
    }

    private fun claimSms(active: Session, task: String, count: Int): Boolean = synchronized(connectionLock) {
        val ws = socket ?: return false
        if (stopped || session !== active) return false
        try {
            execution.runReady(active.connection, ::locallyPaused) { smsStore.claimWithParts(active.connection, task, count) } == true
        } catch (failure: RuntimeException) {
            // Retire this generation even if its uncertain claim rolled back.
            cancelConnection(active, ws)
            throw failure
        }
    }

    private fun <T : Any> withSmsAuthority(active: Session, block: () -> T): T? = synchronized(connectionLock) {
        if (stopped || session !== active || socket == null) null
        else execution.runReady(active.connection, ::locallyPaused, block)
    }

    private fun withCurrentSocket(block: (Session, WebSocket) -> Unit) {
        synchronized(connectionLock) {
            val active = session ?: return
            val ws = socket ?: return
            if (!stopped) block(active, ws)
        }
    }

    // Callers of connection mutation methods hold connectionLock.
    private fun cancelConnection(active: Session, ws: WebSocket) {
        active.connection.observeDisconnect()
        if (active.connection.terminalReason != null) finishConnection(active)
        ws.cancel()
    }

    private fun retireHandshake(active: Session, ws: WebSocket) {
        if (stopped || session !== active || socket !== ws) return
        active.connection.observeDisconnect()
        // Do not leave local recovery dependent on a later transport callback.
        try { finishConnection(active) } finally { ws.cancel() }
    }

    private fun finishConnection(active: Session) {
        if (stopped || session !== active) return
        active.helloDeadline?.close()
        session = null; socket = null; pacer.reset()
        val released = execution.close(active.connection)
        val ticket = ++reconnectTicket
        if (active.connection.terminalReason != null || !released) {
            terminal = true
            handler.removeCallbacks(heartbeat)
            if (active.connection.terminalReason != null && GatewayConnectionObservation.state.terminalClosed(observationToken)) {
                GatewayConnectionObservation.state.notifyObservers()
            }
            Credentials.notifyBindingObservers()
            stopSelf()
            return
        }
        val delay = longArrayOf(1000, 2000, 4000, 8000, 16000, 30000)[reconnects.coerceAtMost(5)]
        reconnects = (reconnects + 1).coerceAtMost(5)
        handler.postDelayed({ lifecycle.run {
            synchronized(connectionLock) {
                if (!stopped && !terminal && ticket == reconnectTicket) connect()
            }
        } }, delay)
    }

    private fun acknowledgeAndFlush(active: Session, ws: WebSocket, ref: String, ok: Boolean) {
        if (pacer.acknowledged(pacer.generation(), ref, ok) { outbox.acknowledge(active.bindingId, ref) }) flushNext(active, ws)
    }

    private fun flushNext(active: Session, ws: WebSocket) {
        try {
            execution.runReady(active.connection, { false }) {
                if (pacer.inFlight != null) return@runReady
                val event = outbox.pendingHead(active.bindingId) ?: return@runReady
                val frame = envelope(event.type, JSONObject(event.payload), event.id, event.createdAt)
                if (!execution.isReady(active.connection)) return@runReady
                check(ws.send(frame.toString()))
                val generation = pacer.generation()
                check(pacer.sent(generation, event.id))
                val scheduled = handler.postDelayed({ lifecycle.run {
                    synchronized(connectionLock) {
                        if (!stopped && session === active && pacer.isInFlight(generation, event.id)) cancelConnection(active, ws)
                    }
                } }, 10000)
                check(scheduled)
                outbox.attempted(active.bindingId, event.id)
            }
        } catch (_: Exception) { cancelConnection(active, ws) }
    }
    private fun envelope(type: String, payload: JSONObject, id: String = Identifiers.event(), ts: Long = System.currentTimeMillis()) = JSONObject().put("v", 1).put("type", type).put("id", id).put("ts", ts).put("payload", payload)
    private fun sendOn(ws: WebSocket, type: String, payload: JSONObject) = ws.send(envelope(type, payload).toString())
    private fun stopResources() {
        var observationEnded = false
        val old = synchronized(connectionLock) {
            stopped = true
            if (::observationToken.isInitialized) observationEnded = GatewayConnectionObservation.state.endInstance(observationToken)
            val previous = socket
            session?.let {
                it.helloDeadline?.close()
                execution.close(it.connection)
            }
            session = null; socket = null; pacer.reset()
            previous
        }
        if (observationEnded) GatewayConnectionObservation.state.notifyObservers()
        Credentials.notifyBindingObservers()
        lifecycle.close {
            if (::commandLedger.isInitialized) Thread { commandLedger.close() }.start()
        }
        if (pauseRegistered) { getSharedPreferences("gateway", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(pauseListener); pauseRegistered = false }
        if (wakeRegistered) { OutboxWake.unregister(outboxWake); wakeRegistered = false }
        handler.removeCallbacksAndMessages(null)
        old?.close(1000, null)
        client.dispatcher().executorService().shutdown()
    }
    override fun onDestroy() { stopResources(); super.onDestroy() }
}
