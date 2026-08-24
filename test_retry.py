import pytest

from retry import RetryConfigError, retry


def test_returns_first_success_without_sleeping():
    calls = []
    result = retry(lambda: calls.append(1) or "ok", sleep=lambda s: pytest.fail("slept"))
    assert result == "ok"
    assert len(calls) == 1


def test_retries_then_succeeds():
    state = {"n": 0}

    def flaky():
        state["n"] += 1
        if state["n"] < 3:
            raise ConnectionError("transient")
        return state["n"]

    slept = []
    assert retry(flaky, attempts=5, sleep=slept.append) == 3
    assert len(slept) == 2


def test_exhaustion_reraises_last_error():
    def always_fails():
        raise TimeoutError("still down")

    with pytest.raises(TimeoutError, match="still down"):
        retry(always_fails, attempts=2, sleep=lambda s: None)


def test_non_retryable_error_propagates_immediately():
    def wrong_kind():
        raise KeyError("not transient")

    with pytest.raises(KeyError):
        retry(wrong_kind, attempts=5, retryable=(ConnectionError,), sleep=lambda s: pytest.fail("slept"))


def test_invalid_config_raises():
    with pytest.raises(RetryConfigError):
        retry(lambda: 1, attempts=0)
