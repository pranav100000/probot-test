"""Bounded retry with exponential backoff and full jitter.

Fails loudly: exhausting attempts re-raises the last error; invalid
configuration raises immediately rather than degrading.
"""

from __future__ import annotations

import random
import time
from collections.abc import Callable
from typing import TypeVar

T = TypeVar("T")


class RetryConfigError(ValueError):
    """Raised for non-positive attempts or negative delays."""


def retry(
    fn: Callable[[], T],
    *,
    attempts: int = 3,
    base_delay: float = 0.1,
    max_delay: float = 2.0,
    retryable: tuple[type[BaseException], ...] = (Exception,),
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Call fn up to attempts times, sleeping with full-jitter backoff between tries.

    The final failure is re-raised unchanged; nothing is swallowed.
    """
    if attempts < 1:
        raise RetryConfigError(f"attempts must be >= 1, got {attempts}")
    if base_delay < 0 or max_delay < 0:
        raise RetryConfigError("delays must be non-negative")

    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fn()
        except retryable as err:  # noqa: PERF203 - clarity over micro-optimisation
            last_error = err
            if attempt == attempts:
                raise
            cap = min(max_delay, base_delay * (2 ** (attempt - 1)))
            sleep(random.uniform(0, cap))
    raise AssertionError("unreachable") from last_error
