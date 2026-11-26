---
tags: runbook, google-wallet, key-rotation, production
confirm: true
---
# Google Wallet Key Rotation

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use to arm and run the 90-day rotation of the Google service account key for managed and shared wallet credentials. Rotation and the daily key inventory call the IAM API as PassBook's own service account. The new key replaces the old one in every managed and shared org credential, and the old key is deleted a day later; at most two keys exist at once. Rotation preserves Google's internal object-identifier HMAC key and does not prove Google approval. Google publication and offers stay unavailable until issuer approval is verified.

Do not put keys, provider tokens or holder capability links in logs, tickets or screenshots.

## Prerequisites

- `gcloud` signed in with IAM admin on the Google Cloud project that owns the service account.
- The IAM API is enabled on that project.

## Parameters

`WALLET_SERVICE_ACCOUNT` is PassBook's Google service account (its address is not stored in this note).

```sh name=set-params confirm=no
export WALLET_SERVICE_ACCOUNT="${WALLET_SERVICE_ACCOUNT:-}"
```

## 1. Grant the IAM role on itself only

Grants `roles/iam.serviceAccountKeyAdmin` on the service account, not on the project.

```sh name=grant-key-admin confirm="Grant roles/iam.serviceAccountKeyAdmin on the PassBook Google service account to itself?"
: "${WALLET_SERVICE_ACCOUNT:?run the params block first}" && gcloud iam service-accounts add-iam-policy-binding "$WALLET_SERVICE_ACCOUNT" --member "serviceAccount:$WALLET_SERVICE_ACCOUNT" --role roles/iam.serviceAccountKeyAdmin
```

## 2. Rotate once by hand

That arms the 90-day schedule. As a platform admin, call `POST /api/v1/platform/wallet-credentials/{id}/rotate-key` for the credential (from the platform wallet page). It is `norun` because it needs your admin session and a credential id.

```sh name=rotate-key norun
POST /api/v1/platform/wallet-credentials/{id}/rotate-key
```

## 3. Watch for stray keys

More than two keys, or a key PassBook did not create, raises `wallet.key_unknown` once a day (audit row, error log, email to platform admins). PassBook never deletes such a key: remove it in Google Cloud. One key found before the first rotation is the uploaded one and is adopted.

## Managed issuers

`issuer.insert` works only for a trusted aggregator's parent issuer. Until Google grants it, a managed-issuer run waits as `google_manual_issuer`: make the issuer in the Google Pay & Wallet Console, share it with PassBook's service account, then complete the run in Platform.
