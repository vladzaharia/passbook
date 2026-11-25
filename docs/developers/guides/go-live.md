---
id: go-live
title: Go live
line: The checklist
status: ready
---
A sandbox never issues a real pass, so going live happens in your organization, not here. You end with a rotated secret, a pinned API version and a Live key. Work through the list in your sandbox first.

## Check your sandbox code

1. Your key comes from `PASSBOOK_KEY`, never from source or a browser. A key sent with browser headers is refused with [403 KEY_IN_BROWSER](/developers/errors/KEY_IN_BROWSER).
2. Every create sends an `Idempotency-Key`: see [issue on purchase](/developers/guides/issue-on-purchase).
3. Every update sends `If-Match` and handles `412 VERSION_CONFLICT`: see [update a pass](/developers/guides/update-a-pass).
4. Errors are read by `code`, not by message. Retry only what the [error entry](/developers/errors) marks retryable, with backoff, and honour `Retry-After` on `429`.
5. Webhook handlers verify the raw body, dedupe on event `id` and answer fast: see [react to events](/developers/guides/react-to-events).
6. Requests send `PassBook-Version` with the date you built against, so a later change never reaches you unannounced. See the [changelog](/developers/changelog).

## Check what your key can do

{{run current-key}}

The scopes should be what your code needs and no more.

## Rotate a webhook secret

Rotate before you launch and when a secret leaks. For `overlapHours` (0, 24 or 72, default 24) both secrets sign each request, one `v1=` each. Deploy the new secret inside that window. A verifier that accepts any matching `v1=` never drops an event.

Get your sandbox's capture endpoint and keep its `id`.

{{run capture-endpoint}}

Then rotate. Paste the endpoint `id` into the path.

{{run rotate-secret}}

The new `secret` is shown once.

## In your real organization

1. Create a Live key with only the scopes you use. See [API keys](/developers/reference/api-keys).
2. Use your own Apple identity for the passes you issue, so they carry your name. Set it in the admin, under Identities. It is not in the API.
3. Release the template to Live: [release a template](/developers/guides/release-a-template).
4. Make a webhook endpoint with your real URL: `POST /webhook-endpoints` with `url` and `eventTypes`. Its secret is shown once. A sandbox keeps its capture endpoint instead.
5. Read the endpoint's first delivery with `GET /webhook-endpoints/{id}/deliveries`, and watch [status](/developers/status) for incidents.

## Result

`GET /api-keys/me` on your sandbox shows `mode: test`. The same call with your Live key shows `mode: live`, your scopes and your organization. The rotated endpoint signs with two `v1=` values until the overlap ends.
