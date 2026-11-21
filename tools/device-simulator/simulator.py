"""Pure simulated device events, never a real device or network."""
import time
from typing import Any


def snapshot(sim_count: int = 1) -> dict[str, Any]:
    if sim_count not in (1, 2):
        raise ValueError("sim_count must be 1 or 2")
    sims = [{"slot": slot, "subId": slot + 1, "carrier": None, "state": "ready", "reportedNumber": None, "mcc": None, "mnc": None} for slot in range(sim_count)]
    now = time.time_ns() // 1_000_000
    probes = {name: {"result": "untested", "probedAt": now, "detail": None} for name in ("smsSend", "smsReceive", "dial", "answer", "hangup", "dtmf", "downlink", "uplink", "earlyMedia")}
    return {"sims": sims, "capabilityLevel": "L1", "probes": probes, "permissions": []}
