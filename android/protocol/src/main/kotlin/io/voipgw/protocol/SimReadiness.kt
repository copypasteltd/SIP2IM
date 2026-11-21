package io.voipgw.protocol

/** Distinguishes observed unavailability from an incomplete telephony observation. */
object SimReadiness {
    enum class State { READY, UNAVAILABLE, UNKNOWN }
    enum class Card { READY, ABSENT, LOCKED, OTHER }
    /** A mismatch requires one unambiguous observed subscription on the requested slot. */
    fun subscriptionMatch(slot: Int, subId: Int, observations: List<Pair<Int, Int>>?): Boolean? {
        if (observations == null) return null
        val onSlot = observations.filter { it.first == slot && it.second >= 0 }
        if (onSlot.size != 1 || observations.count { it.second == onSlot[0].second } != 1) return null
        return onSlot[0].second == subId
    }
    fun decide(card: Card, subscriptionMatches: Boolean?): State = when {
        subscriptionMatches == false -> State.UNAVAILABLE
        card == Card.ABSENT || card == Card.LOCKED -> State.UNAVAILABLE
        card == Card.READY && subscriptionMatches == true -> State.READY
        else -> State.UNKNOWN
    }
}
