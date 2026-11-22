from __future__ import annotations

import json
from pathlib import Path

import pytest

from passbook import WebhookSignatureError, verify_webhook

VECTORS = json.loads((Path(__file__).parents[3] / "docs/api/webhook-vectors.json").read_text())["vectors"]


@pytest.mark.parametrize("v", VECTORS, ids=[v["id"] for v in VECTORS])
def test_vector(v):
    """The same golden vectors every receiver is checked against; `sdk` is what verify_webhook reports."""

    def run():
        return verify_webhook(v["body"], v["headers"], v["secrets"], now=v["now"])

    if v["sdk"] == "ok":
        event = run()
        assert event.id == json.loads(v["body"])["id"]
    else:
        with pytest.raises(WebhookSignatureError) as caught:
            run()
        assert caught.value.reason == v["sdk"]


def test_bytes_and_any_header_case_are_accepted():
    v = VECTORS[0]
    headers = {k.upper(): val for k, val in v["headers"].items()}
    assert verify_webhook(v["body"].encode(), headers, v["secrets"][0], now=v["now"]).type == "pass.updated"


def test_a_list_of_secrets_passes_when_any_matches():
    v = VECTORS[0]
    verify_webhook(v["body"], v["headers"], ["whsec_old", v["secrets"][0]], now=v["now"])


def test_the_event_is_typed_by_its_type():
    v = VECTORS[0]
    event = verify_webhook(v["body"], v["headers"], v["secrets"], now=v["now"])
    assert type(event).__name__ == "PassUpdatedEvent"


def _signed(body: str, secret: str = "whsec_x", ts: int = 1795153318):
    import hashlib
    import hmac

    sig = hmac.new(secret.encode(), f"{ts}.{body}".encode(), hashlib.sha256).hexdigest()
    return {"x-passbook-signature": f"v1={sig}", "x-passbook-timestamp": str(ts)}, ts + 1


def test_an_event_of_an_unknown_type_verifies_and_parses():
    body = json.dumps({"id": "e1", "type": "pass.teleported", "apiVersion": "2027-01-01", "extra": {"a": 1}})
    headers, now = _signed(body)
    event = verify_webhook(body, headers, "whsec_x", now=now)
    assert type(event).__name__ == "UnknownWebhookEvent"
    assert event.type == "pass.teleported" and event.extra == {"a": 1}


def test_a_known_type_with_a_newer_api_version_verifies_and_parses():
    current = json.loads(VECTORS[0]["body"])["apiVersion"]
    body = VECTORS[0]["body"].replace(f'"{current}"', '"2027-01-01"').replace('"mode":"test"', '"mode":"sandbox"')
    assert body != VECTORS[0]["body"]
    headers, now = _signed(body)
    event = verify_webhook(body, headers, "whsec_x", now=now)
    assert event.apiVersion == "2027-01-01"
    assert event.type == "pass.updated"


def test_a_signed_body_that_is_not_an_object_is_a_malformed_error_not_a_pydantic_one():
    headers, now = _signed("[1]")
    with pytest.raises(WebhookSignatureError) as caught:
        verify_webhook("[1]", headers, "whsec_x", now=now)
    assert caught.value.reason == "malformed"


def test_non_ascii_digits_in_the_timestamp_are_malformed():
    v = VECTORS[0]
    headers = {**v["headers"], "x-passbook-timestamp": "١٧٩٥١٥٣٣١٨"}
    with pytest.raises(WebhookSignatureError) as caught:
        verify_webhook(v["body"], headers, v["secrets"], now=v["now"])
    assert caught.value.reason == "malformed"
