---
tags: runbook, wallet, google, samsung, release, production
confirm: true
profile: passbook-owner
env:
  API_URL: https://passbook.mobile
---
# Wallet Provider Flip

Owner only. Agents never run `--remote` or deploy. Releases Google or Samsung in one mode (Test before Live), turns on the orgs that set up before the flip, and rolls back through `draining`. Background: "Wallet release" in [operations](../operations.md).

The release report and the enable-ready dry run are read with a Platform key (`platform:read` and `platform:wallet`, see [[Platform Keys]]), so no session cookie goes into a command. The apply is a person's: it stays on the Release card of Platform > Wallet accounts (the Google and Samsung tabs), which asks for a recent Polaris ID sign-in itself. A key that sends `apply: true` gets 403 `PERSON_REQUIRED`. The other blocks are the deploy gate and CI.

## Prerequisites

- You are signed in to PassBook as a platform admin (for the apply, step 4).
- Profile `passbook-owner` defines `PASSBOOK_KEY`: a Platform key with `platform:read` and `platform:wallet`, made in the console (Platform > API keys) for this flip and revoked after it. It never appears in a command line.
- `gh` is signed in to the repository (for step 3).
- The repository root is a Ledge workspace.

## 1. Read the release report

Define the call, then read the report. It is `GET /api/v1/platform/wallet-release`: the same data as the Release card on Platform > Wallet accounts (the Google and Samsung tabs).

```sh name=define-call confirm=no
: "${PASSBOOK_KEY:?add PASSBOOK_KEY to profile passbook-owner}" &&
pbk() { curl -sS -w '\nHTTP %{http_code}\n' -K - -H 'content-type: application/json' "$@" <<EOF
header = "Authorization: Bearer $PASSBOOK_KEY"
EOF
}
```

```sh name=release-report confirm=no
pbk "$API_URL/api/v1/platform/wallet-release"
```

Read the entry for the mode you will flip. Before the flip PR merges:

- The mode reads Dark, and its credential shows a passing check.
- No organization is blocked as `Legacy account with no source`: a deploy refuses while one exists.
- The organizations you expect are Issuing or Ready, and each Blocked one has a reason you accept.
- Templates show nothing Awaiting review that you meant to ship.
- Wallet copies Open is 0 for any mode that goes dark.

## 2. The flip PR and the deploy gate

The flip is one cell of `RELEASE` and one migration with the single canonical UPDATE (see operations). It merges like any PR and CI deploys it. The card never flips it. Check the placeholders first, then read the plan.

`deploy:check --secrets` reads Cloudflare (`wrangler secret list`, read-only) without asking, so it carries its own confirm.

```sh name=deploy-check confirm="Read the Worker secret list from Cloudflare (read-only)?"
npm run deploy:check -- --secrets
```

The plan is the dry run of a full deploy: upload, bookmark, migrate, promote. It changes nothing.

```sh name=deploy-plan confirm=no
npm run deploy
```

The `Wallet release: <provider> <mode> -> released` line, and the wallet migration gate that runs before the migration, appear in the CI deploy log of the flip commit, not in this plan. Apply the deploy only through [[Deploy]] or the automatic deploy; this note never applies it.

## 3. Wait for the deploy

Finds the deploy run of the flip commit. It must end successful before step 4.

```sh name=deploy-runs confirm=no
gh run list --workflow deploy.yml --branch main --limit 3
```

## 4. Enable ready

After the flip, the mode reads Released. Set the provider and mode, then dry run with the key. It changes nothing.

```sh name=set-release confirm=no
export PROVIDER="${PROVIDER:-google}" && export MODE="${MODE:-test}"
```

```sh name=enable-ready-dry-run confirm=no
pbk -X POST -d '{"apply":false}' "$API_URL/api/v1/platform/wallet-release/$PROVIDER/$MODE/enable-ready"
```

The apply is on the Release card, signed in as a platform admin:

1. The dry run above lists the Off enrolments that were never On and would turn On. An organization that switched itself Off (`Organization turned it Off`) or whose hold was released is not listed; only that organization turns it back On. Confirm the list is the one you expect.
2. Apply, then Turn on. The card sends exactly the listed organizations and each gets its own audit row. If it asks you to confirm it is you, sign in again and click again.
3. If the card says the ready list changed, it names who was added or dropped. Read that, then run the dry run again and apply the new list.
4. Writes go in batches of 20. If an apply fails part way, the earlier batches stay On. Run the dry run again: it lists only what is still Off. Repeat until it says nothing is ready.

## 5. Verify

On the card the mode reads Released, the intended organizations are Issuing, and Ready is 0. Check Wallet copies and the check pill once more, or read the report again with `release-report`. Then revoke the Platform key: Platform > API keys > the key > Revoke.

## Rollback

Rollback is draining, never straight to dark: the same one-cell PR and one-statement migration with `state = 'draining'`. Back to dark only once Wallet copies Open is 0. See [[Wallet Provider Flip Rollback]].
