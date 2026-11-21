"""One test per operation, from tests/ops.json (written by tools/gen-sdk-py.ts).

Each calls the method with values made from the contract, checks the request it sends, and feeds the
client a response made from the contract, so every body, path and result model is exercised.
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qsl

import httpx
import pytest

OPS = json.loads((Path(__file__).parent / "ops.json").read_text())


@pytest.mark.parametrize("op", OPS, ids=[o["call"] for o in OPS])
def test_operation(op, make_client):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if op["raw"]:
            return httpx.Response(200, content=b"raw")
        if "result" not in op:
            return httpx.Response(204)
        return httpx.Response(200, json=op["result"])

    pb = make_client(handler)
    method = pb
    for part in op["call"].split("."):
        method = getattr(method, part)
    args = [i + 1 if p["integer"] else f"id{i + 1}" for i, p in enumerate(op["pathParams"])]
    kwargs = {q["py"]: q["value"] for q in op["query"]}
    if op["binary"]:
        args.append(b"\x89PNG")
    elif "body" in op:
        args.append(op["body"])

    out = method(*args, **kwargs)
    if op["cursor"]:
        assert list(out) == op["result"]["items"] or all(out.items)
    elif op["raw"]:
        assert out.content == b"raw"
    elif "result" not in op:
        assert out is None

    request = seen[0]
    path = op["path"]
    for i, p in enumerate(op["pathParams"]):
        path = path.replace("{" + p["name"] + "}", str(args[i]))
    assert request.method == op["http"]
    assert request.url.path == path
    assert request.headers["authorization"] == "Bearer pb_test_key"
    assert ("idempotency-key" in request.headers) == op["idempotent"]
    for q in op["query"]:
        assert q["name"] in dict(parse_qsl(request.url.query.decode()))
    if op["binary"]:
        assert request.content == b"\x89PNG"
        assert request.headers["content-type"].startswith("image/")
    elif "body" in op:
        assert json.loads(request.content) == op["body"]
