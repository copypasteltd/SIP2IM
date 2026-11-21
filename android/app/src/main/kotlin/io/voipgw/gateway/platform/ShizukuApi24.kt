package io.voipgw.gateway.platform

/** Only load this class after checking SDK >= 24 (the API artifact minimum). */
internal object ShizukuApi24 {
    fun pingBinder(): Boolean = rikka.shizuku.Shizuku.pingBinder()
}
