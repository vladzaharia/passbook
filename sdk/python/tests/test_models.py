from __future__ import annotations

import passbook
from passbook import _generated
from passbook._generated import models


def test_every_model_builds():
    for name in models.__all__:
        value = getattr(models, name)
        if hasattr(value, "model_rebuild"):
            value.model_rebuild(force=True, raise_errors=True)


def test_the_package_exports_every_model_and_none_hides_a_hand_written_name():
    hand_written = {"ApiError", "Page", "PassBook", "ValidationError", "RequestOptions", "verify_webhook"}
    assert not hand_written & set(models.__all__)
    for name in models.__all__:
        assert getattr(passbook, name) is getattr(models, name)
    assert _generated is not None


def test_fields_named_like_python_keywords_use_an_alias():
    sample = {"from": 1, "to": 2}
    keyword_models = [
        m
        for m in (getattr(models, n) for n in models.__all__)
        if hasattr(m, "model_fields") and any(f.alias == "from" for f in m.model_fields.values())
    ]
    for model in keyword_models:
        assert any(name.endswith("_") for name in model.model_fields)
    assert sample


def test_unknown_response_fields_are_kept():
    secret = models.CaptureSecret.model_validate({"secret": "s", "future": True})
    assert secret.model_extra == {"future": True}


def test_a_field_named_pass_is_reachable_as_pass_and_dumped_as_pass():
    event = models.WebhookTestEvent.model_validate(
        {
            "id": "e",
            "type": "webhook.test",
            "apiVersion": "2026-12-01",
            "createdAt": 1,
            "orgId": "o",
            "mode": "test",
            "pass": None,
            "data": {},
        }
    )
    assert event.pass_ is None
    assert "pass" in event.model_dump(by_alias=True)
