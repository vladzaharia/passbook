---
tags: runbook, release, ios, testflight, apps
confirm: true
---
# Release iOS TestFlight

Owner only. Agents never deploy (AGENTS.md); this starts a workflow that uploads to App Store Connect.

Use to push a signed build to TestFlight. Dispatch `iOS TestFlight` from `main` with the marketing version. It runs `npm run check` and the E2E suite, archives with cloud-managed signing, checks the archive, uploads, waits for processing, sets What to Test and adds the build to the group. The build number is the run number plus an offset (`.N` on re-runs); a re-run after a completed upload skips the upload. Internal testers see the build after processing. External testers need Beta App Review.

## Prerequisites

- `gh` signed in with permission to run workflows.
- One-time setup done: [[TestFlight Setup]].

## Parameters

`TESTFLIGHT_VERSION` is `X.Y.Z`. `TESTFLIGHT_GROUP` blank uses the `PASSBOOK_TESTFLIGHT_GROUP` variable; `none` skips adding the group. The workflow's optional What to Test input (`testflight_notes`) defaults to the latest commit subjects.

```sh name=set-params confirm=no
export TESTFLIGHT_VERSION="${TESTFLIGHT_VERSION:-}"
export TESTFLIGHT_GROUP="${TESTFLIGHT_GROUP:-}"
```

## 1. Dispatch

The workflow waits at the `iOS TestFlight` environment if it has required reviewers; approve it in GitHub.

```sh name=dispatch confirm="Start the iOS TestFlight workflow from main with the version in TESTFLIGHT_VERSION (uploads to App Store Connect)?"
: "${TESTFLIGHT_VERSION:?run the params block first}" && gh workflow run ios-testflight.yml --ref main -f version="$TESTFLIGHT_VERSION" -f testflight_group="$TESTFLIGHT_GROUP"
```

## 2. Watch the run

```sh name=watch-run confirm=no
gh run list --workflow ios-testflight.yml --limit 3
```

## 3. Testers

Internal: add the tester to the internal group; the build appears after processing. External: add a group, submit for Beta App Review, share the public link (`TESTFLIGHT_PUBLIC_URL`).
