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
| `passes:read` | GET passes, assets, versions, delivery |
| `passes:write` | create, update, void, refresh, assets, resend email |
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
- Request and response bodies are JSON except `PUT /passes/{id}/assets/{name}` (PNG body) and
  `POST /templates/uploads` (zip or multipart, up to 15 MB).
- Public pass links (`/p/{token}`), the Apple web service (`/wallet/v1`) and webhooks
  (`/hooks/connections/{id}`) have their own auth and are not part of the key API.
