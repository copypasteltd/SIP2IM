package io.voipgw.gateway.telephony

/** Conservative exact match after stripping common formatting; not a dialer. */
object EmergencyGuard {
    private val emergency = setOf("110", "119", "120", "122", "112", "999")
    fun isEmergency(number: String): Boolean = number.filterNot { it == ' ' || it == '-' || it == '(' || it == ')' }.let { it in emergency }
}
