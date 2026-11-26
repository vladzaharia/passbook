---
tags: runbook, release, ios, altstore, apps
confirm: true
---
# Release iOS AltStore

Owner only. Agents never deploy (AGENTS.md); a tag push starts a release workflow.

Use to ship an unsigned IPA for AltStore and SideStore. Tag `ios-vX.Y.Z` from `main`, or dispatch the `iOS AltStore` workflow with a version. The unsigned IPA and checksums go to the GitHub release; then `Apps feeds` rebuilds the AltStore source ([[Refresh App Feeds]]). Free Apple IDs get a 7-day refresh and 3 apps, and NFC Tag Reading may be missing after re-signing.

## Prerequisites

`gh` and `git` signed in with push rights. `main` is green.

## Parameters

Version as `X.Y.Z`.

```sh name=set-params confirm=no
export IOS_VERSION="${IOS_VERSION:-}"
```

## 1. Tag and push

```sh name=tag-release confirm="Tag origin/main with the ios release tag in IOS_VERSION and push it (starts the release build)?"
: "${IOS_VERSION:?run the params block first}" && git fetch -q origin && git tag "ios-v$IOS_VERSION" origin/main && git push origin "ios-v$IOS_VERSION"
```

## 2. Watch the run

```sh name=watch-run confirm=no
gh run list --workflow ios-altstore.yml --limit 3
```

## 3. Verify the release

```sh name=verify-release confirm=no
: "${IOS_VERSION:?run the params block first}" && gh release view "ios-v$IOS_VERSION" --json assets --jq '.assets[].name'
```
