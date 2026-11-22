---
id: org-setup
title: Set up an organization in one call
line: Brand, support, channels
status: ready
---
One request sets an organization's logo, pass colours, support contact and which wallets it allows, and one read tells you what is left to fix. This guide reads the setup, stages a logo, previews a change, applies it, and previews blocking a channel. A new organization is Ready when `checks` has no `warn` or `error` entry.

## Pick a key

- `org:read` reads the setup.
- `brand:manage` also stages images and saves the brand and support. It cannot change channels.
- `org:write` does all of it. Allowing Google or Samsung can also use `wallet:write` or `integrations:manage`.

The key belongs to one organization. A Test key reads the Test setup and changes images and colours. The name, support, email and channels are live-facing, so they need a live key: a Test key gets `403` [MODE_LIVE_REQUIRED](/developers/errors/MODE_LIVE_REQUIRED). A sandbox organization has no live side, so a Test key can change them there.

{{run current-key}}

## Read it

Each channel carries `levels`: PassBook, Plan, Organization, then Template. The first level that is not `ok` stops the channel. `brand` says who set each value in `source`. Each `checks` entry has a stable `code` and a `fix.action`; map the action to the call that fixes it.

{{run pass-setup-read}}

Keep `revision`. You send it back as `expectedRevision`.

## Stage a logo

Upload the PNG first. Nothing about the organization changes: a later save that names the `sha` keeps the file, and an unused one is deleted after 24 hours. Send the @3x as `png`; the @2x is derived unless you send `x2`.

{{show pass-setup-logo}}

## Preview it

`?dryRun=true` runs every rule and writes nothing. It needs no `Idempotency-Key`. `diff` lists each field that would change, `impact` says how many passes are rebuilt and pushed, and `view.checks` is what would remain to fix. Absent leaves a value; `null` clears it.

{{show pass-setup-preview}}

To name the staged logo, add `"logo": { "sha": "<sha>" }` under `brand`. Support is `"support": { "email": "help@acme.test" }` under `brand`, with a live key.

## Apply it

Send an `Idempotency-Key`. The same key and body replays the answer.

{{show pass-setup-apply}}

A stale `expectedRevision` is `409` [PASS_SETUP_CHANGED](/developers/errors/PASS_SETUP_CHANGED): read again and resend. An empty body is `422` [PASS_SETUP_EMPTY](/developers/errors/PASS_SETUP_EMPTY).

## Block a channel

`channels` sets the organization's Allowed switch per channel: `allowed` or `blocked`. Blocking stops new copies; copies already in wallets keep working. The preview counts what stops.

{{show pass-setup-block}}

`impact.channelStops` lists the templates and passes each blocked channel affects. Allowing Google or Samsung also turns the enrolment on when the account is ready, and `impact.enrolments` names it.

## Result

The preview shows `diff`, `impact` and the checks that would remain, and writes nothing. The read runs against your sandbox. Run the writes from your own organization with a live key.
