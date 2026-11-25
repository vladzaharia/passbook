# passbook-sdk

Python client for the PassBook API. Python 3.10+, `httpx` and `pydantic` v2.

```python
import os
from passbook import PassBook

pb = PassBook(api_key=os.environ["PASSBOOK_KEY"])

pass_ = pb.passes.create({
    "templateId": "0193a1b2-7c00-7000-8000-0000000000b1",
    "input": {
        "eventName": "Harbor Night",
        "venueName": "Harbor Hall",
        "venueRegion": "Cupertino, CA",
        "startsAt": "2030-06-01T19:00:00-07:00",
        "endsAt": "2030-06-01T22:00:00-07:00",
        "attendee": "Ada Example",
        "ticketId": "TICKET-0001",
    },
})
```

Resources and methods are named as in the API reference, in snake_case: `pb.passes.create`, `pb.passes.channels.update`, `pb.webhook_endpoints.rotate_secret`. Path parameters come first, then the body (a dict or a model from `passbook`), then the query as keyword arguments, then the options.

Responses are pydantic models with the API's own field names (`pass_.publicUrl`). A field that is a Python keyword gets a trailing underscore (`event.pass_`) and is still `pass` on the wire. Unknown fields are kept in `model_extra`.

## Test mode

A `pbp_test_` key only sees test data, and sandboxes never issue real passes. `pb.mode` reports `"live"` or `"test"` from the key.

## Options

```python
PassBook(api_key, base_url="https://passbook.mobile", http_client=None, max_retries=2, timeout=60.0, api_version=None, user_agent=None)
```

`api_version` is sent as `PassBook-Version` (default: the newest version this SDK was generated against); `user_agent` replaces the User-Agent. Every method also takes `idempotency_key`, `headers`, `max_retries` and `timeout`. Use the client as a context manager, or call `close()`.

## Idempotency and retries

Operations that accept an `Idempotency-Key` (such as `passes.create`) get a fresh UUID per call, reused on every retry. Pass your own to make a retry safe across processes: `pb.passes.create(body, idempotency_key=f"booking-{booking.id}")`.

The SDK retries 429, 5xx and network errors with backoff and jitter, `max_retries` times, and waits out `Retry-After` up to 60 seconds. A 429 is retried for every call. A 5xx or network error is retried for GET, PUT and DELETE, and for POST and PATCH that carry a key. Other writes are not repeated, since the first may have run.

## Pagination

A list returns a `Page`. Iterating it walks every item on every page; `.items` is the first page and `.pages()` walks pages whole.

```python
for pass_ in pb.passes.list(limit=50):
    print(pass_.id)
```

## Errors

A non-2xx answer raises an `ApiError` subclass chosen by status: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `ValidationError` (422), `RateLimitError` (429), `ServerError` (5xx). Branch on `code`, which is stable:

```python
try:
    pb.passes.retrieve(pass_id)
except passbook.NotFoundError as e:
    print(e.code, e.request_id, e.docs_url)
```

`PassBookConnectionError` means no answer came. `ResponseError` means a 2xx answer did not match the documented shape; `.data` holds what was sent.

## Webhooks

```python
event = passbook.verify_webhook(raw_body, request.headers, os.environ["PASSBOOK_WEBHOOK_SECRET"])
```

Pass the body exactly as received. The signature is HMAC-SHA256 over `<timestamp>.<body>`; the timestamp must be within 300 seconds (`tolerance_seconds`). While a secret rotates either secret verifies, and `secret` may be a list. Raises `WebhookSignatureError` with `reason` `missing_header`, `malformed`, `timestamp_out_of_range` or `mismatch`.

## Maintaining

`passbook/_generated` and `tests/ops.json` are generated: `node tools/gen-sdk-py.ts` at the repository root rewrites them from `docs/api/openapi.v1.json` and `docs/api/sdk-names.json`, and `--check` fails on drift. Test with `pip install -e '.[test]' && pytest`. Publishing is the owner's step.
