---
id: go-live
title: Go live
line: The checklist
status: ready
---
A sandbox never issues a real pass, so going live happens in your organization, not here. Work through this list in your sandbox first, then repeat the last two items against the real organization.

## Check your sandbox code

1. Your key comes from `PASSBOOK_KEY`, never from source or a browser. A key sent with browser headers is refused with `403 KEY_IN_BROWSER`.
2. Every create sends an `Idempotency-Key`: see [issue on purchase](/developers/guides/issue-on-purchase).
3. Every update sends `If-Match` and handles `412 VERSION_CONFLICT`: see [update a pass](/developers/guides/update-a-pass).
4. Errors are read by `code`, not by message. Retry only what the [error entry](/developers/errors) marks retryable, with backoff, and honour `Retry-After` on `429`.
5. Webhook handlers verify the raw body, dedupe on event `id` and answer fast: see [react to events](/developers/guides/react-to-events).

## Check what your key can do

{{run current-key}}

The scopes should be what your code needs and no more.

## Rotate a webhook secret

Rotate before you launch and when a secret leaks. For `overlapHours` (0, 24 or 72, default 24) both secrets sign each request, one `v1=` each. Deploy the new secret inside that window; a verifier that accepts any matching `v1=` never drops an event.

Use your sandbox's capture endpoint: get its `id` first.

```json run=webhooks.postWebhookEndpointsCapture
{ "eventTypes": ["pass.issued"] }
```

Then rotate. Paste the endpoint `id` into the path.

```json run=webhooks.postWebhookEndpointsByIdSecret
{ "overlapHours": 24 }
```

The new `secret` is shown once.

## In your real organization

1. Create a Live key with only the scopes you use. See [API keys](/developers/reference/api-keys).
2. Use your own Apple identity for passes you issue, so they carry your name. This is set in the admin, not the API.
3. Make a webhook endpoint with your real URL, and check its first delivery.

## Result

`GET /api-keys/me` on your sandbox shows `mode: test`. The same call with your Live key shows `mode: live`, your scopes and your organization.
