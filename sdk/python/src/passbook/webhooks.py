from __future__ import annotations

import hashlib
import hmac
import re
import time
from typing import Mapping, Sequence

from pydantic import TypeAdapter, ValidationError as PydanticValidationError

from ._errors import WebhookSignatureError
from ._generated.models import WebhookEvent

_event = TypeAdapter(WebhookEvent)
_V1 = re.compile(r"^v1=([0-9a-f]{64})$")


def _header(headers: Mapping[str, str], name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name:
            return value
    return None


def verify_webhook(
    payload: str | bytes,
    headers: Mapping[str, str],
    secret: str | Sequence[str],
    *,
    tolerance_seconds: int = 300,
    now: float | None = None,
) -> WebhookEvent:
    """Checks a webhook delivery and returns the event.

    Pass the raw body exactly as received, before any JSON parsing. The signature is HMAC-SHA256 over
    `<timestamp>.<body>`; while a secret rotates the header lists one `v1=` value per live secret and any
    match passes. An event newer than this SDK (an unknown type or apiVersion) comes back as
    `UnknownWebhookEvent`. Raises `WebhookSignatureError` on a missing, malformed, stale or wrong signature.
    """
    signature = _header(headers, "x-passbook-signature")
    timestamp = _header(headers, "x-passbook-timestamp")
    if not signature or not timestamp:
        raise WebhookSignatureError(
            "missing_header", "The x-passbook-signature and x-passbook-timestamp headers are required."
        )
    candidates = [m.group(1) for part in signature.split(",") if (m := _V1.match(part.strip()))]
    if not re.fullmatch(r"[0-9]{9,12}", timestamp) or not candidates:
        raise WebhookSignatureError("malformed", "The signature or timestamp header is malformed.")
    current = time.time() if now is None else now
    if abs(current - int(timestamp)) > tolerance_seconds:
        raise WebhookSignatureError("timestamp_out_of_range", "The timestamp is outside the tolerance.")

    body = payload.encode() if isinstance(payload, str) else bytes(payload)
    message = timestamp.encode() + b"." + body
    matched = False
    for s in [secret] if isinstance(secret, str) else secret:
        expected = hmac.new(s.encode(), message, hashlib.sha256).hexdigest()
        for hex_ in candidates:
            matched = hmac.compare_digest(expected, hex_) or matched
    if not matched:
        raise WebhookSignatureError("mismatch", "The signature does not match.")
    try:
        return _event.validate_json(body)
    except PydanticValidationError as cause:
        # Signed, so it is PassBook's; it is not an event shape this SDK can read (not a JSON object).
        raise WebhookSignatureError("malformed", "The body is not a JSON event.") from cause
