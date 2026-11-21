---
id: react-to-events
title: React to events
line: Webhooks or polling
status: ready
---
Hear about passes as they change, by webhook or by polling. In a sandbox the webhook goes to a capture endpoint: PassBook stores the signed request instead of sending it, so you read, verify and replay the exact bytes a real endpoint would get. There is no public URL to call.

## Get the capture endpoint

It exists once per sandbox. The first call returns its signing `secret`; later calls return `secret: null`, so save it.

```json run=webhooks.postWebhookEndpointsCapture
{ "eventTypes": ["pass.issued", "pass.updated", "pass.voided"] }
```

Store the secret as `PASSBOOK_WEBHOOK_SECRET`.

## Send a test event

`type` is any event type; every one but `webhook.test` carries sample data. Paste the endpoint `id` into the path.

```json run=webhooks.postWebhookEndpointsByIdTest
{ "type": "pass.issued" }
```

The answer carries `captureId`: the stored request.

## Read it in the tester

Open the [webhook tester](/developers/webhooks). The capture is listed with its headers, raw body and attempt log. The verify panel checks the signature in the page and names the usual mistakes: a re-serialized body, a millisecond timestamp, a rotated secret.

## Verify in your handler

Verify the raw body before you parse it. Parsing first changes the bytes and the check fails.

{{show verify-webhook}}

Reject a timestamp more than 5 minutes off. Dedupe on the event `id`: a delivery can arrive more than once. Answer `2xx` fast and do the work after.

## Replay a capture

[Replay it](console:webhooks.postWebhookEndpointsByIdCapturesByCaptureIdReplay) with the endpoint `id` and the `captureId`, or use Replay in the tester. The same event arrives again, so your handler must dedupe.

## Or poll

The feed carries the same events, oldest first. Keep the cursor from each page, even an empty one.

{{show poll-events}}

## Result

The capture list shows each event with a verified signature and its replays. In your code, a forged request answers `400` and a verified one logs the event.
