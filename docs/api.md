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

An org-bound key only sees its own org. Admin-only routes (orgs, users, identities, settings,
audit, connections, api-keys) need an admin session; keys get 401 or 403.
Limit: 600 requests per minute per key, then 429.

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
- Request and response bodies are JSON except `PUT /passes/{id}/assets/{name}` (PNG body) and
  `POST /templates/uploads` (zip or multipart, up to 15 MB).
- `POST /templates/{id}/versions` (admin session) saves a version of an uploaded template from JSON, with the
  same checks as an upload. Body: `passJson`, `manifest`, `assets` (`{ name, sha1 }` for a file the template
  already has, `{ name, upload }` for a PNG as base64), `dryRun` (validate and build only; returns the report
  and the built pass) and `activate`. Built-in templates answer 403 `TEMPLATE_BAKED`; duplicate one first.
- Public pass and bundle links (`/p/{token}`, `/b/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
