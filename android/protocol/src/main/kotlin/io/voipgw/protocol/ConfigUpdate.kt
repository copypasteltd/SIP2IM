package io.voipgw.protocol

/** Validate supported configuration before it is committed. */
object ConfigUpdate {
    fun error(values: Map<String, Any?>): String? {
        if (values.keys.any { it != "heartbeatSec" && it != "locale" }) return "BAD_MESSAGE"
        if (values.containsKey("heartbeatSec")) {
            val value = values["heartbeatSec"]
            if ((value !is Int && value !is Long) || (value as Number).toLong() !in 1..86400) return "BAD_MESSAGE"
        }
        if (values.containsKey("locale") && values["locale"] !in setOf("en", "zh-CN", "zh-HK")) return "BAD_MESSAGE"
        return null
    }
}
