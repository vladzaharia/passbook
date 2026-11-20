from __future__ import annotations

from typing import Any, Mapping

ERRORS_PAGE = "https://passbook.mobile/developers/errors/"


class PassBookError(Exception):
    """Base of every error the SDK raises."""


class PassBookConnectionError(PassBookError):
    """The request never produced a response: a network failure or a timeout."""


class ApiError(PassBookError):
    """The API answered with a non-2xx status. Branch on `code`, which is stable."""

    def __init__(self, problem: Mapping[str, Any], status: int, headers: Mapping[str, str]) -> None:
        self.status = status
        self.code: str = problem.get("code") or "HTTP_ERROR"
        self.title: str = problem.get("title") or ""
        self.detail: str = problem.get("detail") or self.title or f"HTTP {status}"
        self.request_id: str | None = problem.get("requestId")
        self.issues: list[dict[str, Any]] = list(problem.get("issues") or [])
        self.feature: str | None = problem.get("feature")
        self.limit: int | None = problem.get("limit")
        self.used: int | None = problem.get("used")
        self.type: str = problem.get("type") or f"urn:wallet:problem:{self.code.lower().replace('_', '-')}"
        self.headers = headers
        super().__init__(self.detail)

    @property
    def docs_url(self) -> str:
        if self.type.startswith("https://"):
            return self.type
        return f"{ERRORS_PAGE}{self.code.lower().replace('_', '-')}"


class BadRequestError(ApiError): ...


class AuthenticationError(ApiError): ...


class PermissionDeniedError(ApiError): ...


class NotFoundError(ApiError): ...


class ConflictError(ApiError): ...


class ValidationError(ApiError): ...


class ServerError(ApiError): ...


class RateLimitError(ApiError):
    @property
    def retry_after(self) -> float | None:
        """Seconds from the `Retry-After` header, when sent as a number."""
        try:
            return float(self.headers["retry-after"])
        except (KeyError, ValueError):
            return None


class ResponseError(PassBookError):
    """A 2xx answer that is not JSON, or does not match the documented shape. `data` holds what was sent."""

    def __init__(self, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.data = data


class WebhookSignatureError(PassBookError):
    """`reason` is one of missing_header, malformed, timestamp_out_of_range, mismatch."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


_BY_STATUS: dict[int, type[ApiError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    422: ValidationError,
    429: RateLimitError,
}


def api_error_from(status: int, text: str, headers: Mapping[str, str], reason: str) -> ApiError:
    """Reads the problem body, if there is one, and picks the class for the status."""
    import json

    problem: dict[str, Any] = {}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            problem = parsed
    except ValueError:
        problem = {"detail": text[:200] or reason}
    cls = _BY_STATUS.get(status) or (ServerError if status >= 500 else ApiError)
    return cls({**problem, "status": status}, status, headers)
