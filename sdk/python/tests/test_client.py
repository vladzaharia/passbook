from __future__ import annotations

import json

import httpx
import pytest

import passbook
from passbook import ApiError, NotFoundError, PassBook, PassBookConnectionError, RateLimitError, ValidationError
from passbook._retry import backoff, retry_after

from conftest import body_of, problem, result_of

PASS = {**result_of("passes.retrieve"), "id": "p1"}


def test_a_key_is_required():
    with pytest.raises(passbook.PassBookError):
        PassBook(api_key="")


def test_mode_comes_from_the_key():
    assert PassBook(api_key="pb_test_x").mode == "test"
    assert PassBook(api_key="pb_live_x").mode == "live"
    assert PassBook(api_key="other").mode is None


@pytest.mark.parametrize("prefix", ["pb", "pbp", "pbo"])
def test_mode_reads_every_key_label(prefix):
    assert PassBook(api_key=f"{prefix}_test_x").mode == "test"
    assert PassBook(api_key=f"{prefix}_live_x").mode == "live"


def test_calls_send_the_sdk_user_agent_and_the_newest_api_version(make_client):
    from passbook._generated.api_version import API_VERSION
    from passbook._version import __version__

    seen = []
    pb = make_client(lambda r: (seen.append(r.headers), httpx.Response(200, json=PASS))[1])
    pb.passes.retrieve("p1")
    assert seen[0]["user-agent"] == f"passbook-sdk-python/{__version__}"
    assert seen[0]["passbook-version"] == API_VERSION
    pb = make_client(lambda r: (seen.append(r.headers), httpx.Response(200, json=PASS))[1], api_version="2026-01-01")
    pb.passes.retrieve("p1")
    assert seen[1]["passbook-version"] == "2026-01-01"


def test_a_per_call_header_replaces_the_default_in_any_case(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r.headers), httpx.Response(200, json=PASS))[1], user_agent="mine/1")
    pb.passes.retrieve("p1", headers={"PassBook-Version": "2026-01-01", "User-Agent": "call/2"})
    assert seen[0].get_list("passbook-version") == ["2026-01-01"]
    assert seen[0].get_list("user-agent") == ["call/2"]


def test_user_agent_option(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r.headers), httpx.Response(200, json=PASS))[1], user_agent="mine/1")
    pb.passes.retrieve("p1")
    assert seen[0]["user-agent"] == "mine/1"


def test_the_package_version_matches_pyproject():
    tomllib = pytest.importorskip("tomllib")
    from pathlib import Path

    from passbook._version import __version__

    text = (Path(__file__).parent.parent / "pyproject.toml").read_text()
    assert tomllib.loads(text)["project"]["version"] == __version__


def test_the_key_defaults_to_the_environment(monkeypatch):
    monkeypatch.setenv("PASSBOOK_KEY", "pb_test_env")
    assert PassBook().mode == "test"


def test_a_create_sends_one_idempotency_key_and_reuses_it_on_every_retry(make_client):
    keys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        keys.append(request.headers["idempotency-key"])
        return problem(503, "UNAVAILABLE") if len(keys) < 3 else httpx.Response(201, json=PASS)

    pb = make_client(handler)
    out = pb.passes.create({"templateId": "t1", "input": {}})
    assert out.id == "p1"
    assert len(keys) == 3 and len(set(keys)) == 1
    assert len(pb.sleeps) == 2


def test_a_caller_supplied_idempotency_key_wins(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r.headers["idempotency-key"]), httpx.Response(201, json=PASS))[1])
    pb.passes.create({"templateId": "t1", "input": {}}, idempotency_key="booking-9")
    assert seen == ["booking-9"]


def test_a_write_without_a_key_is_not_repeated_after_a_5xx(make_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return problem(500, "INTERNAL")

    pb = make_client(handler)
    with pytest.raises(passbook.ServerError):
        pb.passes.bulk_reissue({"templateId": "t"})
    assert len(calls) == 1


def test_reads_are_repeated_after_a_5xx_and_a_network_error(make_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            raise httpx.ConnectError("down")
        if len(calls) == 2:
            return problem(502, "BAD_GATEWAY")
        return httpx.Response(200, json=PASS)

    assert make_client(handler).passes.retrieve("p1").id == "p1"
    assert len(calls) == 3


def test_a_429_is_retried_after_retry_after(make_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if len(calls) == 1:
            res = problem(429, "RATE_LIMITED")
            res.headers["retry-after"] = "3"
            return res
        return httpx.Response(200, json=PASS)

    pb = make_client(handler)
    pb.passes.void("p1")
    assert pb.sleeps == [3.0]


def test_a_retry_after_longer_than_a_minute_is_raised(make_client):
    def handler(request: httpx.Request) -> httpx.Response:
        res = problem(429, "RATE_LIMITED")
        res.headers["retry-after"] = "600"
        return res

    pb = make_client(handler)
    with pytest.raises(RateLimitError) as caught:
        pb.passes.retrieve("p1")
    assert caught.value.retry_after == 600
    assert pb.sleeps == []


def test_retries_stop_at_max_retries(make_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return problem(503, "UNAVAILABLE")

    with pytest.raises(passbook.ServerError):
        make_client(handler, max_retries=1).passes.retrieve("p1")
    assert len(calls) == 2


def test_a_network_error_becomes_a_connection_error(make_client):
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    with pytest.raises(PassBookConnectionError):
        make_client(handler, max_retries=0).passes.retrieve("p1")


def test_errors_carry_the_code_and_the_class_for_the_status(make_client):
    pb = make_client(lambda r: problem(404, "PASS_NOT_FOUND", requestId="req_1"))
    with pytest.raises(NotFoundError) as caught:
        pb.passes.retrieve("nope")
    err = caught.value
    assert (err.status, err.code, err.request_id, err.detail) == (404, "PASS_NOT_FOUND", "req_1", "d")
    assert err.docs_url == "https://passbook.mobile/developers/errors/pass_not_found"

    pb = make_client(lambda r: problem(422, "VALIDATION", issues=[{"path": "input.name", "message": "Required"}]))
    with pytest.raises(ValidationError) as invalid:
        pb.passes.create({"templateId": "t", "input": {}})
    assert invalid.value.issues[0]["path"] == "input.name"
    assert isinstance(invalid.value, ApiError)


def test_an_error_without_a_problem_body_still_has_a_code(make_client):
    pb = make_client(lambda r: httpx.Response(500, text="boom"))
    with pytest.raises(passbook.ServerError) as caught:
        pb.passes.bulk_reissue({"templateId": "t"})
    assert caught.value.code == "HTTP_ERROR"
    assert caught.value.detail == "boom"


def test_path_parameters_are_escaped_and_the_query_skips_none(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r), httpx.Response(200, json=PASS))[1])
    pb.passes.retrieve("a/b c")
    assert seen[0].url.raw_path == b"/api/v1/passes/a%2Fb%20c"


def test_a_model_or_a_dict_is_a_body_and_unset_fields_are_not_sent(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(body_of(r)), httpx.Response(201, json=PASS))[1])
    pb.passes.create(passbook.PassesCreateBody(templateId="t1", input={"a": 1}, externalId=None))
    pb.passes.create({"templateId": "t1", "input": {}})
    assert seen == [{"templateId": "t1", "input": {"a": 1}, "externalId": None}, {"templateId": "t1", "input": {}}]


def test_lists_walk_every_page(make_client):
    cursors = []

    def handler(request: httpx.Request) -> httpx.Response:
        cursor = request.url.params.get("cursor")
        cursors.append(cursor)
        pages = {None: ("a", "c1"), "c1": ("b", "c2"), "c2": ("c", None)}
        name, nxt = pages[cursor]
        item = {"id": name, "orgId": "o", "name": name, "prefix": "p", "scopes": [], "createdBy": "u", "createdAt": 0, "lastUsedAt": None, "expiresAt": None, "revokedAt": None}
        return httpx.Response(200, json={"items": [item], "nextCursor": nxt})

    pb = make_client(handler)
    page = pb.api_keys.list(limit=1)
    assert [k.id for k in page] == ["a", "b", "c"]
    assert cursors == [None, "c1", "c2"]
    assert [len(p.items) for p in pb.api_keys.list().pages()] == [1, 1, 1]


def test_a_feed_stops_on_has_more_false(make_client):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"items": [], "nextCursor": "same", "hasMore": False})

    assert list(make_client(handler).events.list()) == []
    assert len(calls) == 1


def test_a_downloads_returns_the_response(make_client):
    pb = make_client(lambda r: httpx.Response(200, content=b"a,b\n"))
    assert pb.pass_imports.download_results("i1").content == b"a,b\n"


def test_a_response_that_does_not_match_says_so_and_keeps_the_data(make_client):
    pb = make_client(lambda r: httpx.Response(200, json={"unexpected": True}))
    with pytest.raises(passbook.ResponseError) as caught:
        pb.passes.retrieve("p1")
    assert caught.value.data == {"unexpected": True}


def test_the_sdk_serializes_json_the_server_can_read(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r), httpx.Response(201, json=PASS))[1])
    pb.passes.create({"templateId": "t", "input": {"n": "é"}})
    assert seen[0].headers["content-type"] == "application/json"
    assert json.loads(seen[0].content)["input"]["n"] == "é"


def test_retry_after_reads_seconds_and_dates_and_ignores_junk():
    assert retry_after("2") == 2
    assert retry_after("") is None and retry_after(None) is None and retry_after("soon") is None
    assert retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480) == 10
    assert retry_after("Wed, 21 Oct 2015 07:28:00 GMT", now=1445412490) == 0


def test_backoff_grows_and_is_capped():
    assert backoff(0, 0.5, 1.0) == 0.5
    assert backoff(1, 0.5, 1.0) == 1.0
    assert backoff(20, 0.5, 0.0) == 4.0


def test_an_unknown_enum_value_in_a_response_still_parses(make_client):
    pb = make_client(lambda r: httpx.Response(201, json={**PASS, "status": "quarantined"}))
    out = pb.passes.create({"templateId": "t1", "input": {}})
    assert out.status == "quarantined"


def test_header_names_are_case_insensitive(make_client):
    seen = []
    pb = make_client(lambda r: (seen.append(r), httpx.Response(201, json=PASS))[1])
    pb.passes.create(
        {"templateId": "t1", "input": {}}, headers={"Idempotency-Key": "mine", "Authorization": "Bearer evil"}
    )
    assert seen[0].headers.get_list("idempotency-key") == ["mine"]
    assert seen[0].headers.get_list("authorization") == ["Bearer pb_test_key"]
