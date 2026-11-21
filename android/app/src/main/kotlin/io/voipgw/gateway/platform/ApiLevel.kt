package io.voipgw.gateway.platform

/** OS capability tier is not evidence of functional telephony or audio. */
object ApiLevel {
    fun tier(api: Int): String {
        require(api >= 19)
        return when { api < 22 -> "L1"; api < 23 -> "L2"; api < 26 -> "L3"; api < 33 -> "L4"; else -> "L5" }
    }
}
