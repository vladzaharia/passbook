---
tags: runbook, wallets, google, samsung
confirm: true
profile: wallet-recording
env:
  GOOGLE_KEY: .secrets/google-demo-service-account.json
  SAMSUNG_KEY: .secrets/samsung-testing-partner.json
---
# Record Wallet Contract Fixtures

Owner only. Records what Google and Samsung really answer, in demo or testing mode, as scrubbed fixtures under `test/fixtures/wallets/{google,samsung}/`. Tests and CI never call a provider; they read those fixtures, which are doc-shape until you record. Never use a live account.

## Prerequisites

- Run from the repository root.
- Profile `wallet-recording` exists in `~/.config/ledge/profiles/`. It holds no secrets the note needs; it may override `GOOGLE_KEY` and `SAMSUNG_KEY`, the paths of the key files.
- `GOOGLE_KEY` is the demo service account JSON. `SAMSUNG_KEY` is `{"partnerId", "certificateId", "privateKeyPem"}` for the testing-mode partner. Both stay under `.secrets/` and are never printed.

## Parameters

Set `ISSUER` (the demo issuer id), `CARD` and `REF` (a Samsung testing card and one saved ref). `TYPES` is optional; empty means every type.

```sh name=set-params confirm=no
export ISSUER="${ISSUER:-}" CARD="${CARD:-}" REF="${REF:-}" CC2="${CC2:-US}" TYPES="${TYPES:-}"
```

## 1. Dry run

Prints every call and the fixture it would write. Reads no key and sends nothing.

```sh name=dry-run-google confirm=no
: "${ISSUER:?run set-params with ISSUER}" && node tools/record-wallet-contract.ts google --issuer "$ISSUER" ${TYPES:+--types "$TYPES"}
```

```sh name=dry-run-samsung confirm=no
: "${CARD:?set CARD}" && : "${REF:?set REF}" && node tools/record-wallet-contract.ts samsung --card "$CARD" --ref "$REF" --cc2 "$CC2" ${TYPES:+--types "$TYPES"}
```

## 2. Record Google

Types: generic, loyalty, giftCard, eventTicket, offer. Per type: class insert and get, object insert, patch, get and `addMessage`.

```sh name=record-google confirm="Call Google Wallet with the demo service account and write test/fixtures/wallets/google?"
: "${ISSUER:?run set-params with ISSUER}" && node tools/record-wallet-contract.ts google --issuer "$ISSUER" --key "$GOOGLE_KEY" ${TYPES:+--types "$TYPES"} --yes-real-provider
```

## 3. Record Samsung

Types: loyalty, ticket, coupon. One Update Notification per state. Generic and gift cards have none.

```sh name=record-samsung confirm="Call Samsung Wallet in testing mode and write test/fixtures/wallets/samsung?"
: "${CARD:?set CARD}" && : "${REF:?set REF}" && node tools/record-wallet-contract.ts samsung --card "$CARD" --ref "$REF" --cc2 "$CC2" --key "$SAMSUNG_KEY" ${TYPES:+--types "$TYPES"} --yes-real-provider
```

## 4. Samsung calls to the Worker

Get Card Data and Send Card State are Samsung calling the Worker. Save one request from the Add to Wallet test tool as JSON (`{method, path, headers, body}`), then scrub it. `CAPTURE` is that file and `NAME` the fixture name.

```sh name=scrub-capture confirm=no
: "${CAPTURE:?set CAPTURE}" && : "${NAME:?set NAME}" && node tools/record-wallet-contract.ts scrub-capture "$CAPTURE" --name "$NAME"
```

## 5. Review

Every body is scrubbed, then checked again; a fixture that still looks like it holds a secret is not written. Read the diff before you commit.

```sh name=review-diff confirm=no
git --no-pager diff --stat -- test/fixtures/wallets && git --no-pager diff -- test/fixtures/wallets
```

A recorded file replaces the doc-shape file of the same name. Samsung's doc-shape fixtures carry `provenance: "doc-shape"`; the recorder omits that key, so a recorded file counts as recorded. `src/passkit/wallets/samsung/contract.test.ts` holds both to the same shapes, so a mismatch after recording is a real finding: fix the compiler or the shape, never the fixture.

The recorder writes only `<type>-update-<state>`; Get Card Data (`<type>-get-card-data`) and Send Card State (`send-card-state-<event>`) come from `scrub-capture` with that `NAME`.

Messages V1 to V6 have their own tool: `tools/record-google-messages.ts`.
