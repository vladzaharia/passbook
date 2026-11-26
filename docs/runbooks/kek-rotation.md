---
tags: runbook, keys, kek, key-rotation, production
confirm: true
profile: passbook-keys
---
# KEK Rotation

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to add a new key-encryption key and move every envelope to it. The highest `KEK_V<n>` encrypts. The MAC keys (scan PIN, pair code, asset grant, pass and bundle link, Apple web-service token `h1:`) derive from the root named by `MAC_KEY_VERSION` (default: the oldest). The credential-tombstone key and the other retained-evidence keys always derive from the oldest root. A root is a KEK, or its `MAC_ROOT_V<n>` (the HKDF-Extract of that KEK: it derives the same keys byte for byte and unwraps no envelope).

This note adds V2 and keeps V1 working. Deleting V1 is a separate, destructive note: [[KEK Retire]].

Do not roll the Worker back to a version uploaded before step 1: its bindings may lack V2.

## Prerequisites

Profile `passbook-keys` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `KEK_V1` (from your vault), and `KEK_V2` (new, see below).

```sh name=generate-kek norun
openssl rand -base64 32
```

Back the new key up outside Cloudflare before step 1.

## 1. Set KEK_V2

New envelopes use V2 at once, and the minute cron `keys.rewrap` starts. It moves the 15 envelope places (credentials, personalizations, APNs keys, webhook payloads and legacy sources, provider credentials, outcomes, Samsung refs and receipts, Google receipts, transfer payloads, the three token seals, captured test emails) to V2, keeping each DEK, iv and ciphertext, so no signing-identity revision or other epoch moves. About 200 rows a minute: 100,000 passes take about 17 hours. Logs: `KEK_REWRAP_RUN` (`moved`, `raced`, `unreadable`).

```sh name=put-kek-v2 confirm="Set KEK_V2 on the production Worker? New envelopes will use it."
: "${KEK_V2:?add it to the profile}" && printf %s "$KEK_V2" | npx wrangler secret put KEK_V2
```

## 2. Wait for the rewrap

`KEK_REWRAP_DONE` (setting `keys.rewrapDone`, stamp `1>2`, with rows left per KEK version) follows one clean sweep. An isolate still on the older version can write a row under V1 after that; once an hour a done pair is probed, and a late row logs `KEK_REWRAP_LATE` and starts a sweep again. Status, Key rotation, shows the rewrap as done.

A row that does not open (wrong AAD, damaged) is left, counted in `unreadable` and logged by id in `KEK_REWRAP_UNREADABLE`: Status is degraded. Delete or restore the row through its module; a done pair with unreadable rows is swept again every hour.

## 3. Escrow the MAC root of V1

`MAC_ROOT_V1` opens no envelope but forges every MAC the KEK would (link and device tokens, PIN hashes, retained evidence): keep it as secret as the KEK and escrow it the same way. Without it, deleting KEK_V1 changes every retained-evidence MAC (retention receipts stop verifying) and fails `requireCredentialRefKeyset` closed (`CREDENTIAL_REF_KEYSET_UNAVAILABLE`). Never delete evidence or reset the keyset sentinel to get around it.

The KEK goes in on stdin from your profile, never from `.secrets/`.

```sh name=put-mac-root-v1 confirm="Derive MAC_ROOT_V1 from KEK_V1 and set it on the production Worker?"
: "${KEK_V1:?add it to the profile}" && printf %s "$KEK_V1" | node tools/keys.ts mac-root | npx wrangler secret put MAC_ROOT_V1
```

## 4. Check the root matches

Wait a minute. While both are set the cron checks that `MAC_ROOT_V1` derives the same keys as `KEK_V1` (`keys.macRoots`). Status, Key rotation, must be verified. A mismatch is failing (`MAC_ROOT_MISMATCH`) and breaks nothing, because KEK_V1 still wins: delete `MAC_ROOT_V1` and redo step 3.

## 5. Dry-run the retirement

Judges the deployed Worker, not the checkout; reads production with `--remote`. It refuses and says why unless every condition holds (rewrap done for `1>2` with `unreadable` 0, an exact count of envelope places on V1 is 0, `KEK_V2` and `MAC_ROOT_V1` set, `keys.macRoots` match within 15 minutes, `MAC_KEY_VERSION_PREVIOUS` is not 1, no staff PIN on root 1 unless the root is set, and 24 hours since the first rewrap run). If it counts rows on V1 (a late row), wait for `KEK_REWRAP_LATE` and the next `KEK_REWRAP_DONE`, then run it again; do not delete the key meanwhile.

```sh name=retire-dry-run confirm=no
npm run keys:retire -- 1
```

## After a KEK_V1 compromise only

A rewrap re-encrypts nothing: a copy of the database plus V1 already holds every DEK, and evidence made under root 1 stays open to offline guessing of its inputs. So also:

1. Run [[MAC Key Rotation]] (`MAC_KEY_VERSION=2`, `MAC_KEY_VERSION_PREVIOUS=1`, wait for `TOKEN_REMAC_DONE`, reset the staff PINs on root 1).
2. Rotate links (`rotate-link`), run credential transfers, and rotate connector secrets, signer keys, the APNs key and provider credentials at their source.

Rekeying retained evidence is deferred (`docs/design/authority-epochs.md`, 7.2).

## Next

Once the dry run passes: [[KEK Retire]]. A deploy check (`npm run deploy:check -- --secrets`) and Status refuse a ring with no KEK, without root 1 (`KEK_V1` or `MAC_ROOT_V1`), with a `MAC_ROOT_V<n>` that is not older than the current KEK, or with a `MAC_KEY_VERSION` that names no root.

Scanner asset grants are stateless (one hour); adding a KEK version changes none of them. To void every outstanding one, deploy with a new label in `asset-grant-mint.ts` (`scan-asset-grant-v2` to `-v3`).
