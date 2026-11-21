"""Offline PCM analysis helpers. No calls, sockets, or device access."""
import math
import struct


def sine_frame(frequency: float = 1000, rate: int = 48000, duration_ms: int = 20, amplitude: int = 10000) -> bytes:
    if rate <= 0 or duration_ms <= 0 or not 0 <= amplitude <= 32767 or not 0 <= frequency < rate / 2:
        raise ValueError("invalid audio parameters")
    count = rate * duration_ms // 1000
    return struct.pack("<" + "h" * count, *(round(amplitude * math.sin(2 * math.pi * frequency * i / rate)) for i in range(count)))


def rms(pcm: bytes) -> float:
    if len(pcm) % 2:
        raise ValueError("PCM16 requires an even byte count")
    if not pcm:
        return 0.0
    samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
    return math.sqrt(sum(sample * sample for sample in samples) / len(samples))
