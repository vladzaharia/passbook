---
tags: runbook, deploy, rollback, production, ci
confirm: true
---
# Rollback Move Deploy Tag

Owner only. Agents never deploy (AGENTS.md).

Use to make CI redeploy an older commit. `.github/workflows/deploy.yml` skips any run whose commit is already contained in the tag `deployed/production`, so an older run cannot roll production back by itself. Moving the tag back lets the older commit deploy. Force-pushes a tag on the shared remote.

First put the live Worker back with [[Rollback]] if production needs relief now.

## Parameters

```sh name=set-params confirm=no
export TARGET_SHA="${TARGET_SHA:-}"
```

## 1. Check the commit

```sh name=show-commit confirm=no
: "${TARGET_SHA:?set TARGET_SHA first}" && git fetch -q origin && git log -1 --oneline "$TARGET_SHA"
```

## 2. Move the tag

```sh name=move-tag confirm="Force-move the deployed/production tag on origin to TARGET_SHA?"
: "${TARGET_SHA:?set TARGET_SHA first}" && git push -f origin "$TARGET_SHA:refs/tags/deployed/production"
```

The next green `ci` run for `main` then deploys from that tag on.
