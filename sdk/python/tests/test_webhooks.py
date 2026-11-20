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
