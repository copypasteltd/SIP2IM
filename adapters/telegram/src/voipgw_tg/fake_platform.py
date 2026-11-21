"""In-memory platform used only by tests; no external operations."""
from typing import Any

class FakePlatform:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    async def handle(self, kind: str, payload: dict[str, Any]) -> tuple[bool, str | None]:
        if kind != 'message.send': return False, 'CAPABILITY_UNSUPPORTED'
        self.messages.append((payload['userId'], payload['text']))
        return True, None
