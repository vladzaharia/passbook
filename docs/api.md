# API

Machine API under `/api/v1`. The reference is generated from the code at `GET /api/v1/openapi.json`
(public). This page covers what the reference does not: auth, conventions, common tasks.

## Authenticate

1. Admin console, API keys, Create. Pick an org (or none for all orgs), scopes, optional expiry.
2. Copy the secret (`wlt_<prefix>_<secret>`). It is shown once; only a hash is stored.
3. Send it as a bearer token. No cookie, no CSRF header.

```
curl https://passbook.mobile/api/v1/passes \
  -H "Authorization: Bearer $WALLET_API_KEY"
```

| Scope | Allows |
|---|---|
| `passes:read` | GET passes, assets, versions, delivery, events, devices, bundles |
| `passes:write` | create, update, void, remove, refresh, assets, resend email, bundles |
| `holders:write` | assign, reassign, unassign holders |
| `templates:read` | GET templates |
| `messages:write` | broadcasts: list, read, create, preview, send, cancel. A `change` also needs `passes:write` |

An org-bound key only sees its own org. Admin-only routes (orgs, users, identities, settings,
audit, connections, api-keys, test-inbox) need an admin session; keys get 401 or 403.
Limit: 600 requests per minute per key, then 429.

### Test mode

A key is live or test (`mode` when it is created; shown with a Test badge and `wlt_test_` in the console,
the secret format is the same). An admin session is test when it sends `x-passbook-mode: test`. Lists and
counts show only the caller's mode; a get by id works in either and returns `mode`. A pass or bundle takes the
creator's mode. Email for a test pass or bundle is never sent: it lands in the Test inbox. Test data older
than `sandbox.purgeDays` (default 30) is deleted daily.

## Errors

`application/problem+json`:

```json
{ "type": "…", "title": "Unprocessable", "status": 422, "code": "VALIDATION",
  "detail": "…", "requestId": "…", "issues": [{ "path": "input.holder", "message": "Required" }] }
```

Branch on `code`, not `detail`. Quote `requestId` when asking for help.

## Create a pass

```
curl -X POST https://passbook.mobile/api/v1/passes \
  -H "Authorization: Bearer $WALLET_API_KEY" \
  -H "Idempotency-Key: member-000123-v1" \
  -H "Content-Type: application/json" \
  -d '{ "orgId": "<org id>", "templateId": "<template id>",
        "input": { "holder": "Alex Morgan", "memberId": "000123" },
        "holderEmail": "alex@example.com", "sendEmail": true }'
```

- `input` is validated against the template's `inputs` schema. See `GET /api/v1/templates/{id}`.
- `Idempotency-Key` (1 to 200 chars): a retry with the same key and body returns the first result.
  The same key with a different body is 409 `IDEMPOTENCY_KEY_REUSED`.
- Optional: `serial`, `externalId`, `identityId`, `templateVersion`, `connectionId` + `externalRef`.
- The response carries the pass id, the download link and the current `version`.

## Update a pass

`PATCH /api/v1/passes/{id}` with `If-Match: <version>`. A stale version returns 412
`VERSION_CONFLICT`: re-read and retry. A changed pass is rebuilt and pushed to its devices.

```
curl -X PATCH https://passbook.mobile/api/v1/passes/$ID \
  -H "Authorization: Bearer $WALLET_API_KEY" -H "If-Match: 3" \
  -H "Content-Type: application/json" \
  -d '{ "input": { "points": 1300 } }'
```

## Holders

```
POST /api/v1/holders/assign        { "passId": "…", "email": "alex@example.com" }
POST /api/v1/holders/assign-bulk   { "items": [ { "passId": "…", "email": "…" } ] }   (max 100)
POST /api/v1/holders/unassign      { "passId": "…" }
```

`assign` works on an unowned pass. An owned pass changes hands through `reassign`.

## Other

- Lists take `limit` (1 to 200) and `cursor`; the response has `nextCursor` (null at the end).
- `void` and `unvoid` toggle a pass; `rotate-link` invalidates the old download link.
- `POST /passes/{id}/remove` (`{ message? }`) publishes a last version that is voided and expired, so Wallet
  moves it to Expired passes; no API deletes a pass from a device. `POST /passes/{id}/restore` undoes it.
  Bulk: `POST /passes/bulk` with `action: "remove"`.
- `GET /passes/{id}/events` is the sync log, newest first: `kind` (one or a comma list) or `group`
  (`delivery`, `devices`, `changes`). `GET /passes/{id}/devices` is per-device sync and push state.
- `POST /bundles` (`{ orgId, passIds, name, holderEmail?, sendEmail? }`) shares 1 to 10 passes of one org
  behind one link, `/b/{token}`. Then `send-email`, `rotate-link` and `DELETE` on `/bundles/{id}`.
- `POST /broadcasts` sends a message, or a scheduled change of any inputs, to the active passes a `target`
  matches (`templateIds`, optional `onDevice`, `holderState`, `q`). A `message` sets `patch: { message: text }`
  on templates with `manifest.messaging`; an empty text clears it. `send` is `draft`, `now` or `schedule` (with
  `at`); `clearAfter` (ms) clears a message later. `POST /broadcasts/preview` counts a target first.
  `POST /broadcasts/{id}/send` sends a draft, `POST /broadcasts/{id}/cancel` stops a draft or schedule.
  Progress is in `GET /broadcasts/{id}` (`state`, `counts`).
- A pass notifies its holder at most `push.budgetPerDay` times (default 3) in 24 h; later changes publish
  silently. `GET /passes/{id}` has `pushBudget` (`used`, `limit`, `resetsAt`). An update that leaves the pass
  unchanged is never pushed.
- `GET /test-inbox` and `GET /test-inbox/{id}` (admin session in Test mode) list and show captured email.
  `POST /test-inbox/{id}/send-to-me` sends one to the signed-in admin's verified address.
- Request and response bodies are JSON except `PUT /passes/{id}/assets/{name}` (PNG body) and
  `POST /templates/uploads` (zip or multipart, up to 15 MB).
- `POST /templates/{id}/versions` (admin session) saves a version of an uploaded template from JSON, with the
  same checks as an upload. Body: `passJson`, `manifest`, `assets` (`{ name, sha1 }` for a file the template
  already has, `{ name, upload }` for a PNG as base64), `dryRun` (validate and build only; returns the report
  and the built pass) and `activate`. Built-in templates answer 403 `TEMPLATE_BAKED`; duplicate one first.
- Public pass and bundle links (`/p/{token}`, `/b/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
