# API

All `/api/*` routes require `Authorization: Bearer <ADMIN_TOKEN>`. Public routes never list members. Request bodies are limited to 32 KiB. Schema violations return 400; unknown template IDs return 404. Errors do not include credentials or provider response bodies.

## Issue a pass

`POST /api/passes`

```json
{
  "templateId": "henrys",
  "serial": "member-000123",
  "personalization": {
    "memberName": "Alex Morgan",
    "memberId": "000123",
    "membership": "All-Inclusive Wellness",
    "homeClub": "Capitol Hill",
    "access": "Home club"
  },
  "email": "member@example.com"
}
```

Omit `serial` to generate a UUID. Omit `email` for download-only issuance. The blue theme's template ID is `henrys-blue`. Choose `Queen Anne` to direct the native location action to that gym. `access` may be `Home club` or `All clubs`; it controls location relevance, not membership authorization.

The 201 response includes `serial`, `version`, `revision`, `walletURL`, `downloadURL`, and `emailStatus: "queued"` when requested. A duplicate serial returns 409. For issuance retries, supply the same serial and retrieve the existing pass after 409. An email queue failure does not invalidate the already stored pass; the durable outbox is dispatched again by Cron.

Optional inputs include `status`, `message`, `voided`, `expirationDate`, and `memberPortalURL`. `GET /api/templates` returns the exact schema and registered source IDs. Member IDs are strings and must contain only Code 39 characters (`A-Z`, digits, space, `- . $ / + %`); start/stop `*` is prohibited.

## Read and edit

| Method / path | Result |
| --- | --- |
| `GET /api/templates` | Template schemas and source IDs |
| `GET /api/passes` | Up to 50 passes, filtered `total`, and an optional `next` cursor |
| `GET /api/passes/:serial` | Current personalization, private links, version, source status, last 20 delivery records |
| `PATCH /api/passes/:serial` | Merge allowed personalization fields and issue an update |
| `PUT /api/passes/:serial/source` | Attach, replace, or detach a registered update source |
| `POST /api/passes/:serial/sync` | Queue a source refresh |
| `POST /api/passes/:serial/email` | Queue email with an idempotency key |
| `POST /api/passes/:serial/deliveries/:id/retry` | Reset a failed delivery for another bounded retry cycle |

Pass listing accepts `q` (name, member number, or serial; up to 100 characters), `template` (registered template ID), `status`, and `after` (the previous page's `next` cursor). Search is case-insensitive and treats `%` and `_` literally. Filters apply before pagination, so search covers the entire directory. Keep the same filters when requesting the next page. Each row includes `homeClub`, effective `status`, and `modified` alongside its serial, template, member details, version, and source state. `status=Voided` selects passes with `voided: true`; other status filters exclude voided passes.

Updates require `If-Match: "1"` using the version returned by GET:

```json
{
  "personalization": {
    "homeClub": "Queen Anne",
    "message": "Welcome to your new home gym."
  }
}
```

The service regenerates and signs the pass, then queues a push. Missing `If-Match` returns 428; an outdated version returns 412; a race after signing returns 409. Fetch the current state before retrying. Unchanged data returns `changed: false` without signing or sending a push. An empty personalization patch rebuilds a pass when its deployed template version has increased.

Use `null` to remove an optional input such as `expirationDate`. Required fields cannot be removed. `status` is display text; setting it manually does not automatically set `voided`. Explicitly set both when invalidating a pass. The sample API source maps inactive membership to `Suspended` plus `voided: true`.

To attach the example API source on issuance, add:

```json
"source": { "id": "membership-api", "reference": "your-member-record-id" }
```

For existing passes, PUT the same `{"source": {...}}` body to `/source`; use `{"source": null}` to detach it. In-flight refreshes from an earlier source configuration cannot publish changes after replacement or detachment.

To send again, POST `{"to":"member@example.com"}` to `/email` with `Idempotency-Key: welcome-2026-10`. Reusing that key with the same recipient returns the existing delivery; a different recipient returns 409. A new key deliberately creates another delivery. States are `pending`, `processing`, `sent`, or `failed`. `provider_id` is the accepted email message ID when available.

## Member and Wallet routes

`GET /p/:downloadToken` shows the member's private pass page. `GET /p/:downloadToken/pass.pkpass` returns `application/vnd.apple.pkpass`. The download token is independent of Apple's registration credential.

Issued passes advertise `webServiceURL: https://wallet.plrs.im/wallet`. Apple's routes are:

| Route | Authentication / behavior |
| --- | --- |
| `POST /wallet/v1/devices/:device/registrations/:type/:serial` | `ApplePass <authenticationToken>`; 201 new, 200 existing |
| `DELETE /wallet/v1/devices/:device/registrations/:type/:serial` | Same authentication; unregister |
| `GET /wallet/v1/devices/:device/registrations/:type?passesUpdatedSince=…` | Apple's opaque device library ID; returns serials and a monotonic cursor, or 204 |
| `GET /wallet/v1/passes/:type/:serial` | `ApplePass` authentication; signed pass or 304 |
| `POST /wallet/v1/log` | Bounded `logs` array; records the count without retaining potentially sensitive content |

Update cursors use a database sequence, not timestamps. Downloads support ETags and Last-Modified; ambiguous changes within one second return the bytes instead of incorrectly hiding an update.
# Service status

`GET /api/status` uses the same administrator bearer token as pass management. It returns `checkedAt`, an overall `state`, pass/device/delivery counts in `metrics`, and individual `components` with a state and explanatory detail. States distinguish `healthy`, `warning`, `error`, `configured`, and `unconfigured`. These checks read storage and configuration; they do not send test emails, pushes, or upstream membership requests. The authenticated browser view is `/status`.

