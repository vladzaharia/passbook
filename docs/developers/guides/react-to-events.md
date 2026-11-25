---
id: react-to-events
title: React to events
line: Webhooks or polling
status: ready
---
Hear about passes as they change, by webhook or by polling. In a sandbox the webhook goes to a capture endpoint: PassBook stores the signed request instead of sending it, so you read, verify and replay the exact bytes a real endpoint would get. You end with a captured event whose signature you verified.

## Get the capture endpoint

Your sandbox has one capture endpoint, made with the sandbox. The call returns it with its `id`, and `secret: null`: a new endpoint shows its secret once, and yours already exists. It takes every event type, so the body is empty.

{{run capture-endpoint}}

Read the secret from the endpoint. Paste its `id` into the path, then store the answer as `PASSBOOK_WEBHOOK_SECRET`.

{{run read-capture-secret}}

## Send a test event

`type` is any event type. Every one but `webhook.test` carries sample data. The answer carries `captureId`, the stored request.

{{run send-test-event}}

Read the capture with the endpoint `id` and the `captureId`. It holds the headers and the raw body, exactly as signed. The [webhook tester](/developers/webhooks) shows the same capture and checks it in the page.

{{run read-capture}}

## Verify the signature

The signature is HMAC-SHA256 over `<x-passbook-timestamp>.<raw body>`, in lowercase hex, sent as `v1=<hex>` in `x-passbook-signature`. The timestamp is unix seconds. While a secret rotates the header lists one `v1=` per secret, comma separated: accept any match.

Check the stored capture from a terminal. It needs `jq` and `openssl`.

{{show verify-capture}}

> **Warning:** Verify the raw body. A body you parsed and serialized again never verifies.

In your handler, reject a timestamp more than 5 minutes off and dedupe on the event `id`: a delivery can arrive more than once. Answer `2xx` fast and do the work after. This handler needs no SDK.

{{show verify-webhook}}

## Replay a capture

Replay signs the stored body again with a new timestamp and stores it as a new capture. The event `id` is the same, so your handler must dedupe. Paste the endpoint `id` and the `captureId`.

{{run replay-capture}}

## Or poll

The feed carries the same events, oldest first. Keep `nextCursor` from each page, even an empty one, and send it as `after`.

{{run poll-events}}

## If it fails

| Code | Cause | Fix |
| --- | --- | --- |
| [404 WEBHOOK_ENDPOINT_NOT_FOUND](/developers/errors/WEBHOOK_ENDPOINT_NOT_FOUND) | The path `id` is not an endpoint of this key. | Use the `endpoint.id` from the first step. |
| [404 WEBHOOK_CAPTURE_NOT_FOUND](/developers/errors/WEBHOOK_CAPTURE_NOT_FOUND) | The `captureId` is not stored on this endpoint. | Use the `captureId` from the test answer. |
| [409 NOT_A_CAPTURE_ENDPOINT](/developers/errors/NOT_A_CAPTURE_ENDPOINT) | The endpoint sends to a URL. | Use the capture endpoint. |
| [429 RATE_LIMITED](/developers/errors/RATE_LIMITED) | Too many test sends. | Wait for `Retry-After`. |

## Result

The test event's capture holds a signed request. The terminal check prints `verified`, and the replay stores a second capture with the same event `id`.
