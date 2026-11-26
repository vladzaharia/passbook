---
tags: runbook, release, android, apps
confirm: true
---
# Release Android Reader

Owner only. Agents never deploy (AGENTS.md); a tag push starts a release workflow.

Use to ship a new PassBook Reader. Tag `android-vX.Y.Z` from `main`: the `Android Reader` workflow builds the signed APK, AAB and checksums and attaches them to the GitHub release. The AAB goes to Play internal testing when the `PLAY_SERVICE_ACCOUNT_JSON` secret is set. The `Apps feeds` workflow follows and republishes the F-Droid repo ([[Refresh App Feeds]]).

## Prerequisites

- `gh` and `git` signed in with push rights.
- Repo secrets `ANDROID_READER_KEYSTORE_B64` and `ANDROID_READER_SIGNING_PASSWORD` exist. Play first-time setup: [[Play Console Setup]].
- `main` is green.

## Parameters

Version without the `android-v` prefix, as `X.Y.Z`.

```sh name=set-params confirm=no
export ANDROID_VERSION="${ANDROID_VERSION:-}"
```

## 1. Tag and push

```sh name=tag-release confirm="Tag origin/main with the android release tag in ANDROID_VERSION and push it (starts the release build)?"
: "${ANDROID_VERSION:?run the params block first}" && git fetch -q origin && git tag "android-v$ANDROID_VERSION" origin/main && git push origin "android-v$ANDROID_VERSION"
```

## 2. Watch the run

```sh name=watch-run confirm=no
gh run list --workflow android.yml --limit 3
```

## 3. Verify the release

Lists the release assets: APK, AAB and checksums.

```sh name=verify-release confirm=no
: "${ANDROID_VERSION:?run the params block first}" && gh release view "android-v$ANDROID_VERSION" --json assets --jq '.assets[].name'
```
