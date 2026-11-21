"""Length-prefixed core IPC frames; parsing is bounded before buffering a body."""
import json
import struct
from typing import Any, List, Tuple

MAX_FRAME = 1024 * 1024


def encode_frame(kind: int, body: bytes) -> bytes:
    if kind not in (1, 2) or len(body) + 1 > MAX_FRAME:
        raise ValueError("invalid frame")
    return struct.pack(">I", len(body) + 1) + bytes([kind]) + body


def encode_control(message: dict[str, Any]) -> bytes:
    return encode_frame(1, json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


class FrameDecoder:
    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> List[Tuple[int, bytes]]:
        self._buffer.extend(data)
        frames: List[Tuple[int, bytes]] = []
        while len(self._buffer) >= 4:
            length = struct.unpack_from(">I", self._buffer)[0]
            if length < 1 or length > MAX_FRAME:
                raise ValueError("invalid frame length")
            if len(self._buffer) < 4 + length:
                break
            kind = self._buffer[4]
            if kind not in (1, 2):
                raise ValueError("invalid frame type")
            frames.append((kind, bytes(self._buffer[5:4 + length])))
            del self._buffer[:4 + length]
        return frames
