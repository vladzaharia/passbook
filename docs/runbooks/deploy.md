---
tags: runbook, deploy, production
confirm: true
profile: passbook-owner
---
# Deploy

Owner only. Agents never deploy or use `--remote` (AGENTS.md). CI already deploys every green `main` commit ([[Automatic Deploys Setup]]); use this note for a manual deploy, for example when CI has no secrets or you need a specific commit.

Uploads a Worker version (not serving yet), records a D1 Time Travel bookmark in `.wrangler/d1-bookmarks.log`, applies remote migrations, runs the entitlements gate, then promotes the version. Run it from the repo root on a clean tree at the commit you want to ship.

The first deploy of a Worker, or a release that adds a queue consumer, a workflow or a Durable Object class, is a different flow: [[Deploy First]].

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the token scopes are listed in [[Automatic Deploys Setup]]).

Never run `wrangler deploy` or `wrangler versions upload` for the main Worker yourself: only `npm run deploy` checks the build stamp and scans `dist/` for the e2e release.

## 1. Check placeholders and secrets

Lists what is still a placeholder in `wrangler.jsonc` and any required secret that is unset.

```sh name=deploy-check confirm=no
npm run deploy:check -- --secrets
```

## 2. Full check

Gen, lint, rules, typecheck, tests and build. Takes a while; the tree must stay clean afterwards.

```sh name=full-check confirm=no
npm run check
```

## 3. Dry run

Prints the plan and changes nothing.

```sh name=deploy-plan confirm=no
npm run deploy
```

## 4. Apply

Refuses on placeholders or an unset required secret. `--apply` runs every check first. Add flags after `--`, for example `--allow-no-push` when the APNs binding is not set up yet.

```sh name=deploy-apply confirm="Upload, migrate and promote a new Worker version to production?"
npm run deploy -- --apply
```

Cloudflare error 100146 ("version could not be found") right after upload is transient: rerun step 4. Migrations already applied are skipped.

## 5. Verify

Checks the public paths. `/` is 200, and the API answers 401 without a key.

```sh name=verify-health confirm=no
curl -sS -o /dev/null -w '%{http_code}\n' https://passbook.mobile/health && curl -sS -o /dev/null -w '%{http_code}\n' https://passbook.mobile/api/v1/orgs
```

```text
200
401
```

Then open Status in the admin console: every component should be verified or configured. If templates cannot issue, see [[Deploy Promote and Baked Sync]].

## If it went wrong

Migrations are forward-only. Prefer a fix-forward commit; to put the previous Worker version back, see [[Rollback]]. Never restore D1 to undo a deploy.
