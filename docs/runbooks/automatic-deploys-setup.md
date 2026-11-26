---
tags: runbook, ci, deploy, github, production
confirm: true
profile: passbook-owner
---
# Automatic Deploys Setup

Owner only. Agents never deploy (AGENTS.md); CI does, once this is in place.

One-time setup for `.github/workflows/deploy.yml`, which deploys every green commit on `main`: the `ci` workflow finishes for a push to `main`, and the deploy checks out that run's `head_sha`, never a PR and never a newer unchecked commit. Runs queue (`production-deploy`, never cancelled). The tag `deployed/production` marks the last deployed commit; a run whose commit is already in the tag is skipped. With no secrets the run ends with a notice and succeeds, nothing is deployed and the tag does not move. What the workflow does, step by step, is in [docs/operations.md](../operations.md#automatic-deploys).

Workers Builds connected to the repo needs no GitHub secret but builds outside the `ci` gate, the secret check, the `--first` logic and the smoke checks. Use GitHub Actions.

## Prerequisites

- `gh` is signed in with admin rights on the repo.
- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` for the new token.

## 1. Create the Cloudflare API token

In the Cloudflare dashboard (My Profile, API Tokens, Create custom token) with:

- Account: Workers Scripts Edit, D1 Edit, Queues Edit, Workers R2 Storage Edit, Account Settings Read
- Zone: Workers Routes Edit, DNS Edit, Zone Read on `passbook.mobile` and `plrs.im`
- User: User Details Read

Scope accounts and zones to this account. The token can redeploy any Worker in the account, including `apple-provisioner`; see its trust boundary in [docs/operations.md](../operations.md#apple-provisioner). Add the value to the profile.

## 2. Create the `production` environment

Optional: Required reviewers. That makes every deploy wait for an approval, so it is no longer automatic. Optional: restrict deployment branches to `main`.

```sh name=create-environment confirm="Create or update the production environment on this GitHub repo?"
gh api -X PUT "repos/{owner}/{repo}/environments/production"
```

## 3. Add the secrets

Values come from the profile through stdin.

```sh name=set-api-token confirm="Set CLOUDFLARE_API_TOKEN in the production environment?"
: "${CLOUDFLARE_API_TOKEN:?add it to the profile}" && printf %s "$CLOUDFLARE_API_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN --env production
```

```sh name=set-account-id confirm="Set CLOUDFLARE_ACCOUNT_ID in the production environment?"
: "${CLOUDFLARE_ACCOUNT_ID:?add it to the profile}" && printf %s "$CLOUDFLARE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID --env production
```

## 4. Verify

```sh name=list-env-secrets confirm=no
gh secret list --env production
```

The next green `main` commit deploys everything since. Watch the job summary: sha, version now serving, migrations that were pending. Smoke checks run against `https://passbook.mobile`.

If a deploy needs relief: [[Rollback]].
