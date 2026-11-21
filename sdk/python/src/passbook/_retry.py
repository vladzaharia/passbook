from __future__ import annotations

import random
import time
from email.utils import parsedate_to_datetime

# Longest `Retry-After` the SDK waits out; a longer one is raised to the caller as the error.
MAX_RETRY_AFTER = 60.0
_MAX_BACKOFF = 8.0


def retry_after(header: str | None, now: float | None = None) -> float | None:
    """Seconds from a `Retry-After` value (seconds or an HTTP date), or None when absent or unusable."""
    if header is None or header.strip() == "":
        return None
    try:
        return max(0.0, float(header))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(header).timestamp()
    except (TypeError, ValueError):
        return None
    return max(0.0, when - (time.time() if now is None else now))


def backoff(attempt: int, base: float, rand: float | None = None) -> float:
    """Exponential backoff with jitter: about base, 2x, 4x, capped."""
    jitter = random.random() if rand is None else rand
    return min(_MAX_BACKOFF, base * 2**attempt) * (0.5 + jitter / 2)
