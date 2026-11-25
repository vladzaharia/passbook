from __future__ import annotations

import os
import re
from typing import Literal

import httpx

from ._core import Core
from ._generated.resources import Resources


class PassBook(Resources):
    """The PassBook API client.

        pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])
        pass_ = pb.passes.create({
            "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
            "input": {"eventName": "Harbor Night", "attendee": "Ada Example", "ticketId": "TICKET-0001", ...},
        })

    A `pbp_test_` key works in test mode: sandboxes never issue real passes. Use it as a context manager,
    or call `close()`, to release the connection pool.
    """

    #: From the key's prefix; None for a key that does not follow the `pb[p|o]_<mode>_` format.
    mode: Literal["live", "test"] | None

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = "https://passbook.mobile",
        http_client: httpx.Client | None = None,
        max_retries: int = 2,
        timeout: float = 60.0,
        retry_delay: float = 0.5,
        api_version: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("PASSBOOK_KEY", "")
        self._core = Core(key, base_url, http_client, max_retries, timeout, retry_delay, api_version=api_version, user_agent=user_agent)
        super().__init__(self._core)
        found = re.match(r"(?:pb|pbp|pbo)_(live|test)_", key)
        self.mode = found.group(1) if found else None  # type: ignore[assignment]

    def close(self) -> None:
        self._core.client.close()

    def __enter__(self) -> PassBook:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
