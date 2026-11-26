---
tags: runbook, release, android, play, apps
confirm: true
---
# Play Console Setup

Owner only. Agents never deploy (AGENTS.md).

One-time setup so `Android Reader` releases reach Play internal testing ([[Release Android Reader]]). The app is `im.plrs.passbook.reader`. Most steps are in Play Console and Google Cloud; the commands set GitHub secrets and variables from a file.

Losing the app signing key is serious: enrol in Play App Signing with the existing app key so every channel shares one signature, and keep using the same key as the upload key.

## Prerequisites

- `gh` signed in with admin rights on the repo.
- Repo secrets `ANDROID_READER_KEYSTORE_B64` and `ANDROID_READER_SIGNING_PASSWORD` (the app key) already exist.

## Parameters

```sh name=set-params confirm=no
export PLAY_SERVICE_ACCOUNT_FILE="${PLAY_SERVICE_ACCOUNT_FILE:-}"
export PLAY_INTERNAL_URL="${PLAY_INTERNAL_URL:-}"
```

## 1. Console and forms (UI)

1. Create the Play Console developer account and the app `im.plrs.passbook.reader`.
2. Fill the content forms: privacy policy, data safety, app access, ads, content rating, target audience.

## 2. Play App Signing (UI plus one local command)

Play Console, Test and release, App signing, upload an existing key. Google gives you an encryption key; set it in the command, which writes `pepk.zip` for upload. The keystore alias is `passbook-reader`.

```sh name=pepk norun
java -jar pepk.jar --keystore=KEYSTORE_FILE --alias=passbook-reader --output=pepk.zip --include-cert --encryptionkey=GOOGLE_ENCRYPTION_KEY
```

## 3. Service account (UI)

In Google Cloud create a service account and enable the Android Publisher API. In Play Console, Users and permissions, invite it with release permission for the app. Save its JSON key to a file outside the repo and set `PLAY_SERVICE_ACCOUNT_FILE`.

```sh name=set-service-account-secret confirm="Set the PLAY_SERVICE_ACCOUNT_JSON secret on this GitHub repo?"
: "${PLAY_SERVICE_ACCOUNT_FILE:?run the params block and set the file path}" && gh secret set PLAY_SERVICE_ACCOUNT_JSON < "$PLAY_SERVICE_ACCOUNT_FILE"
```

## 4. First release and variables

Upload the first release once by hand and create the internal testing list. Until the first release completes, release as a draft.

```sh name=set-release-status-draft confirm="Set the PLAY_RELEASE_STATUS variable to draft on this GitHub repo?"
gh variable set PLAY_RELEASE_STATUS --body draft
```

After the first release completes, remove the variable so releases go live in internal testing (`norun` so a full run of this note keeps the draft setting), and set the opt-in link testers use.

```sh name=unset-release-status norun
gh variable delete PLAY_RELEASE_STATUS
```

```sh name=set-internal-url confirm="Set the PLAY_INTERNAL_URL variable on this GitHub repo?"
: "${PLAY_INTERNAL_URL:?run the params block and set the link}" && printf %s "$PLAY_INTERNAL_URL" | gh variable set PLAY_INTERNAL_URL
```

Add testers' emails to the internal list in Play Console and send them the opt-in link.
