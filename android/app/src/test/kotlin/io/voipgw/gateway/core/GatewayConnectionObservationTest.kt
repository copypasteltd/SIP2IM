package io.voipgw.gateway.core

import org.junit.Assert.*
import org.junit.Test

class GatewayConnectionObservationTest {
    @Test fun staleInstanceCannotReplaceCurrentObservation() {
        val observation = TerminalConnectionObservation()
        val old = observation.beginInstance()
        observation.terminalClosed(old)
        assertEquals(TerminalConnectionObservation.State.TERMINAL_CLOSED, observation.current())
        val current = observation.beginInstance()
        observation.terminalClosed(old)
        assertEquals(TerminalConnectionObservation.State.UNKNOWN, observation.current())
        observation.terminalClosed(current)
        observation.terminalClosed(old)
        assertEquals(TerminalConnectionObservation.State.TERMINAL_CLOSED, observation.current())
    }

    @Test fun stopAndNewInstanceRejectStaleCloseAndStop() {
        val observation = TerminalConnectionObservation()
        val old = observation.beginInstance()
        assertTrue(observation.terminalClosed(old))
        assertTrue(observation.endInstance(old))
        assertFalse(observation.terminalClosed(old))
        assertEquals(TerminalConnectionObservation.State.UNKNOWN, observation.current())
        val current = observation.beginInstance()
        assertFalse(observation.endInstance(old))
        assertTrue(observation.terminalClosed(current))
        assertFalse(observation.terminalClosed(old))
        assertEquals(TerminalConnectionObservation.State.TERMINAL_CLOSED, observation.current())
    }

    @Test fun observersSeeLatestStateAndCanUnregister() {
        val observation = TerminalConnectionObservation()
        val seen = mutableListOf<TerminalConnectionObservation.State>()
        val observer = { seen.add(observation.current()); Unit }
        observation.register(observer)
        val token = observation.beginInstance()
        if (observation.terminalClosed(token)) observation.notifyObservers()
        if (observation.terminalClosed(token)) observation.notifyObservers()
        observation.unregister(observer)
        observation.beginInstance()
        assertEquals(listOf(TerminalConnectionObservation.State.UNKNOWN, TerminalConnectionObservation.State.TERMINAL_CLOSED), seen)
    }
}
