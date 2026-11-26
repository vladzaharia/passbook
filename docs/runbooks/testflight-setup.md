---
tags: runbook, release, ios, testflight, apps
confirm: true
profile: passbook-testflight
---
# TestFlight Setup

Owner only. Agents never deploy (AGENTS.md).

One-time setup for the `iOS TestFlight` workflow ([[Release iOS TestFlight]]). The app is `mobile.passbook.scanner`. Done by the Apple Account Holder. Most steps are in Apple's portals; the commands set GitHub secrets and variables from the profile and a key file.

## Prerequisites

- `gh` signed in with admin rights on the repo.
- Profile `passbook-testflight` defines `ASC_KEY_ID`, `ASC_ISSUER_ID` (App Store Connect, Users and Access, Integrations) and `APPLE_TEAM_ID`.
- The `.p8` of an **Admin** team API key (so Xcode can create the distribution certificate and profiles), stored outside the repo.

## Parameters

```sh name=set-params confirm=no
export ASC_KEY_FILE="${ASC_KEY_FILE:-}"
export TESTFLIGHT_GROUP_NAME="${TESTFLIGHT_GROUP_NAME:-}"
```

## 1. Apple portals (UI)

1. Certificates, Identifiers & Profiles: register the App ID `mobile.passbook.scanner` with **NFC Tag Reading**.
2. App Store Connect: My Apps, **+**, New App, iOS, bundle ID `mobile.passbook.scanner`. Accept the agreements.
3. Create an internal TestFlight group on the app record.

## 2. GitHub environment

The workflow environment is named `iOS TestFlight`. Optionally add required reviewers there.

```sh name=create-environment confirm="Create or update the iOS TestFlight environment on this GitHub repo?"
gh api -X PUT "repos/{owner}/{repo}/environments/iOS%20TestFlight"
```

## 3. Secrets

```sh name=set-key-id confirm="Set ASC_KEY_ID in the iOS TestFlight environment?"
: "${ASC_KEY_ID:?add it to the profile}" && printf %s "$ASC_KEY_ID" | gh secret set ASC_KEY_ID --env "iOS TestFlight"
```

```sh name=set-issuer-id confirm="Set ASC_ISSUER_ID in the iOS TestFlight environment?"
: "${ASC_ISSUER_ID:?add it to the profile}" && printf %s "$ASC_ISSUER_ID" | gh secret set ASC_ISSUER_ID --env "iOS TestFlight"
```

```sh name=set-key-p8 confirm="Set ASC_KEY_P8_BASE64 in the iOS TestFlight environment?"
: "${ASC_KEY_FILE:?run the params block and set the .p8 path}" && base64 < "$ASC_KEY_FILE" | tr -d '\n' | gh secret set ASC_KEY_P8_BASE64 --env "iOS TestFlight"
```

## 4. Variables

`APPLE_TEAM_ID` is a repository variable. Optional variables: `PASSBOOK_TESTFLIGHT_GROUP` (the internal group name), `PASSBOOK_BUILD_NUMBER_OFFSET` (default 1000), `PASSBOOK_RELEASE_XCODE_BUILD`, and `TESTFLIGHT_PUBLIC_URL` for an external group with a public link.

```sh name=set-team-id confirm="Set the APPLE_TEAM_ID variable on this GitHub repo?"
: "${APPLE_TEAM_ID:?add it to the profile}" && printf %s "$APPLE_TEAM_ID" | gh variable set APPLE_TEAM_ID
```

```sh name=set-group confirm="Set the PASSBOOK_TESTFLIGHT_GROUP variable on this GitHub repo?"
: "${TESTFLIGHT_GROUP_NAME:?run the params block and set the group name}" && printf %s "$TESTFLIGHT_GROUP_NAME" | gh variable set PASSBOOK_TESTFLIGHT_GROUP
```

## 5. Verify

```sh name=list-secrets confirm=no
gh secret list --env "iOS TestFlight"
```

Then run [[Release iOS TestFlight]].
