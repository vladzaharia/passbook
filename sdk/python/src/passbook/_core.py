from __future__ import annotations

import json
import time
import uuid
from typing import Any, Callable, Mapping, TypedDict
from urllib.parse import quote

import httpx
from pydantic import BaseModel, TypeAdapter
from pydantic import ValidationError as _PydanticValidationError

from ._errors import PassBookConnectionError, PassBookError, ResponseError, api_error_from
from ._generated.api_version import API_VERSION
from ._pagination import Page
from ._retry import MAX_RETRY_AFTER, backoff, retry_after
from ._version import __version__

# Safe to repeat after a lost response (RFC 9110); POST and PATCH are, only with an idempotency key.
_REPEATABLE = {"GET", "PUT", "DELETE"}
_adapters: dict[Any, TypeAdapter[Any]] = {}


class RequestOptions(TypedDict, total=False):
    """Keyword arguments every method takes after its own."""

    #: Sent as `Idempotency-Key` on operations that accept one. Default: a fresh UUID per call, reused across retries.
    idempotency_key: str
    #: Extra headers for this call.
    headers: Mapping[str, str]
    #: Overrides the client's `max_retries`.
    max_retries: int
    #: Overrides the client's `timeout`, in seconds, per attempt.
    timeout: float


def path_param(value: Any) -> str:
    return quote(str(value), safe="")


def _default(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True, exclude_unset=True)
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def _query(query: Mapping[str, Any] | None) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for name, value in (query or {}).items():
        if value is None:
            continue
        for v in value if isinstance(value, (list, tuple)) else [value]:
            out.append((name, ("true" if v else "false") if isinstance(v, bool) else str(v)))
    return out


class Core:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        client: httpx.Client | None,
        max_retries: int,
        timeout: float,
        retry_delay: float,
        sleep: Callable[[float], None] = time.sleep,
        api_version: str | None = None,
        user_agent: str | None = None,
    ) -> None:
        if not isinstance(api_key, str) or api_key.strip() == "":
            raise PassBookError("api_key is required: pass a pbp_live_ or pbp_test_ key.")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.client = client or httpx.Client()
        self.max_retries = max_retries
        self.timeout = timeout
        self.retry_delay = retry_delay
        self.sleep = sleep
        self.api_version = api_version or API_VERSION
        self.user_agent = user_agent or f"passbook-sdk-python/{__version__}"

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        body: Any = None,
        idempotent: bool = False,
        raw: bool = False,
        content_type: str | None = None,
        result: Any = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
        max_retries: int | None = None,
        timeout: float | None = None,
    ) -> Any:
        # Header names are case-insensitive: fold them so a user's `Idempotency-Key` replaces ours.
        head = {
            "accept": "application/json",
            "user-agent": self.user_agent,
            "passbook-version": self.api_version,
            **{k.lower(): v for k, v in (headers or {}).items()},
        }
        head["authorization"] = f"Bearer {self.api_key}"
        content: bytes | None = None
        if content_type:
            content = body
        elif body is not None:
            content = json.dumps(body, default=_default).encode()
        if content is not None:
            head["content-type"] = content_type or "application/json"
        key = (idempotency_key or head.get("idempotency-key") or str(uuid.uuid4())) if idempotent else None
        if key:
            head["idempotency-key"] = key
        repeatable = method in _REPEATABLE or key is not None
        retries = self.max_retries if max_retries is None else max_retries
        url = f"{self.base_url}{path}"
        params = _query(query)

        attempt = 0
        while True:
            try:
                res = self.client.request(
                    method,
                    url,
                    params=params,
                    headers=head,
                    content=content,
                    timeout=self.timeout if timeout is None else timeout,
                )
            except httpx.TransportError as cause:
                if not repeatable or attempt >= retries:
                    raise PassBookConnectionError(f"Could not reach PassBook: {cause}") from cause
                self.sleep(backoff(attempt, self.retry_delay))
                attempt += 1
                continue
            if res.is_success:
                return self._parse(res, raw, result)
            error = api_error_from(res.status_code, res.text, res.headers, res.reason_phrase)
            # A 429 was refused before it ran, so any call may repeat; a 5xx may have run.
            retryable = res.status_code == 429 or (res.status_code >= 500 and repeatable)
            asked = retry_after(res.headers.get("retry-after"))
            if not retryable or attempt >= retries or (asked is not None and asked > MAX_RETRY_AFTER):
                raise error
            self.sleep(asked if asked is not None else backoff(attempt, self.retry_delay))
            attempt += 1

    def _parse(self, res: httpx.Response, raw: bool, result: Any) -> Any:
        if raw:
            return res
        if res.status_code == 204 or res.text == "":
            return None
        try:
            data = res.json()
        except ValueError as cause:
            raise ResponseError("The response was not valid JSON.") from cause
        if result is None:
            return data
        adapter = _adapters.get(result)
        if adapter is None:
            adapter = _adapters[result] = TypeAdapter(result)
        try:
            return adapter.validate_python(data)
        except _PydanticValidationError as cause:
            raise ResponseError(f"The response did not match the documented shape: {cause}", data) from cause

    def paginate(self, method: str, path: str, *, cursor_param: str, query: Mapping[str, Any], **kwargs: Any) -> Page[Any]:
        def fetch(cursor: str | None) -> Any:
            return self.request(method, path, query={**query, cursor_param: cursor}, **kwargs)

        start = query.get(cursor_param)
        return Page(fetch(start), fetch, start)
