---
tags: runbook, release, apps, fdroid, altstore
confirm: true
---
# Refresh App Feeds

Owner only. Agents never deploy (AGENTS.md).

Use to rebuild the install page and feeds by hand. The `Apps feeds` workflow downloads every `android-v*` and `ios-v*` release, builds the F-Droid repo and the AltStore source, and deploys GitHub Pages. It runs after a release and after the two release workflows (releases made with `GITHUB_TOKEN` do not fire `release`), so by hand is only needed after a fix or a failed run. The job fails if the F-Droid index key does not match `FDROID_REPO_FINGERPRINT`.

Feeds: AltStore and SideStore `altstore/source.json` (id `mobile.passbook.source`), F-Droid and Droid-ify `fdroid/repo`, both under the install page; Obtainium takes the GitHub repo URL. The install page and exact feed URLs are listed in [docs/operations.md](../operations.md#app-distribution).

Losing the F-Droid index key means everyone re-adds the repo.

## Prerequisites

`gh` signed in with permission to run workflows. Secrets `FDROID_KEYSTORE_B64`, `FDROID_KEYSTORE_PASS` and variables `FDROID_KEY_ALIAS`, `FDROID_REPO_FINGERPRINT` are set.

## 1. Dispatch

```sh name=dispatch confirm="Start the Apps feeds workflow (deploys GitHub Pages)?"
gh workflow run apps-feeds.yml --ref main
```

## 2. Watch the run

```sh name=watch-run confirm=no
gh run list --workflow apps-feeds.yml --limit 3
```
