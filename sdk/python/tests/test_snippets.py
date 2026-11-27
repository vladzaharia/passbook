"""Every generated Python snippet runs: against a server that answers from the contract."""
from __future__ import annotations

import json
import re
import runpy
from pathlib import Path

import httpx
import pytest

import passbook.client

SNIPPETS = sorted((Path(__file__).parents[3] / "docs/developers/snippets/generated/py").glob("*.py"))
OPS = {o["id"]: o for o in json.loads((Path(__file__).parent / "ops.json").read_text())}


def test_there_is_a_snippet_for_every_operation():
    # The portal publishes no platform operations (isPublished in the developer model: x-platform-scope or a platform resource), so they have no snippet.
    published = {i for i, o in OPS.items() if o["published"]}
    assert {p.stem for p in SNIPPETS} == published


@pytest.mark.parametrize("path", SNIPPETS, ids=[p.stem for p in SNIPPETS])
def test_snippet(path, monkeypatch, tmp_path):
    op = OPS[path.stem]
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if op["raw"]:
            return httpx.Response(200, content=b"raw")
        if "result" not in op:
            return httpx.Response(204)
        return httpx.Response(200, json=op["result"])

    real = httpx.Client
    monkeypatch.setattr(passbook.client.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setenv("PASSBOOK_KEY", "pb_test_key")
    (tmp_path / "image.png").write_bytes(b"\x89PNG")
    monkeypatch.chdir(tmp_path)
    runpy.run_path(str(path))

    assert seen, "the snippet made no request"
    pattern = re.sub(r"\\\{\w+\\\}", "[^/]+", re.escape(op["path"]))
    assert seen[0].method == op["http"]
    assert re.fullmatch(pattern, seen[0].url.path)
