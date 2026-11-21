package io.voipgw.gateway.core

import io.voipgw.protocol.BindingAddress
import okio.ByteString
import java.security.SecureRandom

/** Version 2 request fields are immutable once the private pending row has committed. */
internal data class BindingMetadata(
    val manufacturer: String,
    val model: String,
    val apiLevel: Int,
    val apkVersion: String,
    val apkCode: Int,
    val locale: String
) {
    init {
        require(text(manufacturer, 128) && text(model, 128) && text(apkVersion, 64))
        require(apiLevel > 0 && apkCode >= 0)
        require(text(locale, 64))
    }

    private companion object {
        fun text(value: String, max: Int): Boolean = value.length <= max && '\u0000' !in value &&
            value == String(value.toByteArray(Charsets.UTF_8), Charsets.UTF_8)
    }
}

internal data class PendingBinding(
    val version: Int,
    val attemptId: String,
    val bearer: String,
    val origin: String,
    val code: String,
    val metadata: BindingMetadata
) {
    init {
        require(version == 2 && BindingV2Encoding.canonical(attemptId, 16) && BindingV2Encoding.canonical(bearer, 32))
        require(BindingAddress.origin(origin) == origin && BindingAddress.code(code))
    }

    override fun toString() = "PendingBinding(version=$version)"

    // The version-specific serialization is deterministic from the stored fields only.
    fun requestBody(): String = with(metadata) {
        "{" + listOf(
            "\"protocolVersion\":$version", "\"attemptId\":" + quote(attemptId), "\"code\":" + quote(code),
            "\"manufacturer\":" + quote(manufacturer), "\"model\":" + quote(model), "\"apiLevel\":$apiLevel",
            "\"apkVersion\":" + quote(apkVersion), "\"apkCode\":$apkCode", "\"locale\":" + quote(locale)
        ).joinToString(",") + "}"
    }

    private fun quote(value: String) = buildString {
        append('"')
        for (ch in value) when (ch) {
            '"', '\\' -> append('\\').append(ch)
            in '\u0000'..'\u001F' -> append("\\u").append(ch.code.toString(16).padStart(4, '0'))
            else -> append(ch)
        }
        append('"')
    }

    companion object {
        fun create(origin: String, code: String, metadata: BindingMetadata) = PendingBinding(
            2, BindingV2Encoding.random(16), BindingV2Encoding.random(32), origin, code, metadata
        )
    }
}

internal object BindingV2Encoding {
    private val random = SecureRandom()
    private val alphabet = Regex("[A-Za-z0-9_-]+")

    private fun encode(bytes: ByteString): String = bytes.base64Url().trimEnd('=')

    fun random(size: Int): String {
        val bytes = ByteArray(size)
        random.nextBytes(bytes)
        return encode(ByteString.of(*bytes))
    }

    fun canonical(value: String, size: Int): Boolean {
        if (value.length != (size * 8 + 5) / 6 || !alphabet.matches(value)) return false
        val raw = ByteString.decodeBase64(value) ?: return false
        return raw.size() == size && encode(raw) == value
    }
}

/** Strictly recognizes the small v2 proof envelope without Android's lenient, coercing JSON parser. */
internal class BindingProof private constructor(val attemptId: String, val deviceId: String) {
    companion object {
        const val MAX_BYTES = 512
        private const val WS = "[ \\t\\r\\n]*"
        private val envelope = Regex("$WS\\{$WS\"data\"$WS:$WS\\{([^{}]*)\\}$WS\\}$WS")
        private val field = Regex("$WS\"(protocolVersion|attemptId|deviceId)\"$WS:$WS(2|\"[A-Za-z0-9_-]+\")$WS")
        private val deviceId = Regex("dev_[0-7][0-9A-HJKMNP-TV-Z]{25}")

        fun parse(body: String): BindingProof? {
            if (body.length > MAX_BYTES) return null
            val content = envelope.matchEntire(body)?.groupValues?.get(1) ?: return null
            val fields = mutableMapOf<String, String>()
            for (part in content.split(',')) {
                val (_, name, value) = field.matchEntire(part)?.groupValues ?: return null
                if (fields.put(name, value) != null) return null
            }
            if (fields["protocolVersion"] != "2") return null
            val attempt = fields["attemptId"]?.removeSurrounding("\"") ?: return null
            val id = fields["deviceId"]?.removeSurrounding("\"") ?: return null
            if (!BindingV2Encoding.canonical(attempt, 16) || !deviceId.matches(id)) return null
            return BindingProof(attempt, id)
        }
    }
}
