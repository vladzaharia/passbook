---
id: org-setup
title: Set up an organization in one call
line: Brand, support, channels
status: ready
---
One request sets an organization's logo, pass colours, support contact and which wallets it allows, and one read tells you what is left to fix. This guide reads the setup, stages a logo, previews a change and a channel block, then applies the change. A new organization is Ready when `checks` has no `warn` or `error` entry.

## Pick a key

The key belongs to one organization.

| Scope | Allows |
| --- | --- |
| `org:read` | Read the setup |
| `brand:manage` | Also stage images and save brand and support. Not channels |
| `org:write` | All of it. Allowing Google or Samsung can also use `wallet:write` or `integrations:manage` |

The key's mode decides what it may change:

| Key | Image and colours | Name, support, email, channels |
| --- | --- | --- |
| Test, in a sandbox | Yes | Yes: a sandbox has no live side |
| Test, in an organization | Yes | `403` [MODE_LIVE_REQUIRED](/developers/errors/MODE_LIVE_REQUIRED) |
| Live | Yes | Yes |

{{run current-key}}

## Read it

Each channel carries `levels`: PassBook, Plan, Organization, then Template. The first level that is not `ok` stops the channel. `brand` says who set each value in `source`. Each `checks` entry has a stable `code` and a `fix.action`; map the action to the call that fixes it. A new sandbox has `SUPPORT_MISSING`.

{{run pass-setup-read}}

Keep `revision`: you send it back as `expectedRevision`. A new sandbox reads `test.1.0.0`, which the curl examples below use; send your own.

## Stage a logo

Upload the PNG first. Nothing about the organization changes: a later save that names the `sha` keeps the file, and an unused one is deleted after 24 hours. Send the @3x as `png`; the @2x is derived unless you send `x2`.

{{show pass-setup-logo}}

To use it, add `"logo": { "sha": "<sha>" }` under `brand`.

## Preview it

`?dryRun=true` runs every rule and writes nothing. It needs no `Idempotency-Key`. `diff` lists each field that would change, `impact` says how many passes are rebuilt and pushed, and `view.checks` is what would remain to fix. Absent leaves a value; `null` clears it.

{{show pass-setup-preview}}

## Block a channel

`channels` sets the organization's Allowed switch per channel: `mobile` (the PassBook app), `apple`, `google`, `samsung`, `paper` or `nfc`. Each is `allowed` or `blocked`. Blocking stops new copies; copies already in wallets keep working. The preview counts what stops. Outside a sandbox it needs a live key.

{{show pass-setup-block}}

`impact.channelStops` lists the templates and passes each blocked channel affects. A sandbox has only `mobile` on, so this preview adds a `NO_CHANNEL` error: holders would get nothing. Don't apply it. Allowing Google or Samsung also turns the enrolment on when the account is ready, and `impact.enrolments` names it.

## Apply it

Send an `Idempotency-Key`. The same key and body replays the answer.

{{show pass-setup-apply}}

A stale `expectedRevision` is `409` [PASS_SETUP_CHANGED](/developers/errors/PASS_SETUP_CHANGED): read again and resend. An empty body is `422` [PASS_SETUP_EMPTY](/developers/errors/PASS_SETUP_EMPTY).

## Result

Read the setup again. `brand.passColors.source` is `org`, `revision` has moved, and `checks` still lists `SUPPORT_MISSING`. Clear it: add `"support": { "email": "help@harborhall.example" }` under `brand` and apply again with the new revision. `checks` is empty: Ready. A Test key does this in a sandbox. In your own organization, support needs a live key.
