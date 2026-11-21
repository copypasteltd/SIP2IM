package io.voipgw.protocol

/** Validates untrusted decoded commands before any side effect is considered. */
object CommandValidation {
    private val commandId = Regex("cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}")
    private fun string(p: Map<String, Any?>, key: String) = (p[key] as? String)?.isNotBlank() == true
    private fun integer(value: Any?): Boolean = value is Int || value is Long
    private fun sub(p: Map<String, Any?>) = p.containsKey("subId") && (p["subId"] == null || integer(p["subId"]))
    private fun media(p: Map<String, Any?>): Boolean {
        val m = p["media"] as? Map<*, *> ?: return false
        return listOf("sessionId", "legId", "path").all { (m[it] as? String)?.isNotBlank() == true } && integer(m["format"])
    }
    fun valid(id: String, type: String, p: Map<String, Any?>): Boolean {
        if (!commandId.matches(id)) return false
        if (type.startsWith("call.") && p.containsKey("generation") &&
            (p["generation"] as? String)?.matches(Regex("gen_[0-7][0-9A-HJKMNP-TV-Z]{25}")) != true) return false
        return when (type) {
            "sms.send" -> string(p, "taskId") && sub(p) && integer(p["slot"]) && string(p, "to") && string(p, "body")
            "call.dial" -> string(p, "callId") && sub(p) && integer(p["slot"]) && string(p, "to") && media(p)
            "call.answer" -> string(p, "callId") && media(p)
            "call.reject", "call.hangup" -> string(p, "callId")
            "call.dtmf" -> string(p, "callId") && (p["digits"] as? String)?.matches(Regex("[0-9*#]+")) == true
            "probe.run" -> (p["items"] as? List<*>)?.all { it is String } == true
            "config.update" -> (!p.containsKey("heartbeatSec") || integer(p["heartbeatSec"])) && (!p.containsKey("locale") || p["locale"] is String)
            else -> false
        }
    }
}
