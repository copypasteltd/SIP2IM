"""Fail-closed adapter behavior until a verified platform backend exists."""
import secrets
import time
from typing import Any

_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def _id() -> str:
    number = (int(time.time() * 1000) << 80) | secrets.randbits(80)
    chars = []
    for _ in range(26):
        chars.append(_ALPHABET[number & 31])
        number >>= 5
    return "ipc_" + "".join(reversed(chars))


def envelope(kind: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {"v": 1, "type": kind, "id": _id(), "ts": int(time.time() * 1000), "payload": payload}


def startup() -> list[dict[str, Any]]:
    return [
        envelope("adapter.hello", {"platform": "telegram", "adapterVersion": "0.1.0", "protocol": 1}),
        envelope("capabilities", {"login": False, "sendMessage": False, "receiveMessage": False, "dial": False, "receiveAudio": False, "sendAudio": False, "maxConcurrentCalls": 0}),
        envelope("account.state", {"state": "logged_out", "selfId": None, "alias": None, "detail": "platform backend unavailable"}),
    ]


def handle(message: dict[str, Any]) -> dict[str, Any] | None:
    if message.get("type") == "ack":
        return None
    ref = message.get("id")
    if not isinstance(ref, str):
        raise ValueError("missing message id")
    return envelope("ack", {"refId": ref, "ok": False, "error": "CAPABILITY_UNSUPPORTED"})
