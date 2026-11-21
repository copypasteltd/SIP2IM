"""Validate locally supplied raw PCM prompt boundaries and duration."""


def validate(pcm: bytes, rate: int = 16000) -> None:
    if rate <= 0 or len(pcm) % 2 or not 1.5 * rate * 2 <= len(pcm) <= 2.5 * rate * 2:
        raise ValueError("expected 1.5–2.5 seconds of mono PCM16")
    boundary = rate * 2 // 5
    if any(pcm[:boundary]) or any(pcm[-boundary:]):
        raise ValueError("expected 200 ms silence at both ends")
