from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

import httpx
import pytest

from passbook import PassBook

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture
def make_client():
    """A client whose HTTP calls go to `handler`, with no waiting between retries."""
    sleeps: list[float] = []

    def make(handler: Handler, **options) -> PassBook:
        pb = PassBook(
            api_key="pb_test_key",
            http_client=httpx.Client(transport=httpx.MockTransport(handler)),
            **options,
        )
        pb._core.sleep = sleeps.append
        pb.sleeps = sleeps  # type: ignore[attr-defined]
        return pb

    return make


def problem(status: int, code: str, **extra) -> httpx.Response:
    body = {"type": f"https://passbook.mobile/developers/errors/{code.lower()}", "title": "t", "status": status, "code": code, "detail": "d", **extra}
    return httpx.Response(status, json=body, headers={"content-type": "application/problem+json"})


def result_of(call: str):
    """A response that satisfies the contract for `call`, from tests/ops.json."""
    ops = json.loads((Path(__file__).parent / "ops.json").read_text())
    return next(o["result"] for o in ops if o["call"] == call)


def body_of(request: httpx.Request):
    return json.loads(request.content) if request.content else None
