---
tags: runbook, wallet, google, samsung, release, production
confirm: true
---
# Wallet Provider Flip

Owner only. Agents never run `--remote` or deploy. Releases Google or Samsung in one mode (Test before Live), turns on the orgs that set up before the flip, and rolls back through `draining`. Background: "Wallet release" in [operations](../operations.md).

The platform state is read and applied in the browser, on the Release card of Platform > Wallet accounts (the Google and Samsung tabs). The enable-ready routes need a recent Polaris ID sign-in, which the card asks for itself, so no session cookie or token goes into a profile or a command. The blocks below are the deploy gate and CI.

## Prerequisites

- You are signed in to PassBook as a platform admin.
- `gh` is signed in to the repository (for step 3).
- The repository root is a Ledge workspace.

## 1. Read the Release card

Open <https://passbook.mobile/admin/platform/wallet-accounts>, pick the Google or Samsung tab and read the card for the mode you will flip. Before the flip PR merges:

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

## 4. Enable ready, in the card

After the flip, the mode reads Released. On the same card:

1. Run dry run. It lists the Off enrolments that were never On and would turn On. An organization that switched itself Off (`Organization turned it Off`) or whose hold was released is not listed; only that organization turns it back On. Confirm the list is the one you expect.
2. Apply, then Turn on. The card sends exactly the listed organizations and each gets its own audit row. If it asks you to confirm it is you, sign in again and click again.
3. If the card says the ready list changed, it names who was added or dropped. Read that, then Run the dry run again and apply the new list.
4. Writes go in batches of 20. If an apply fails part way, the earlier batches stay On. Run the dry run again: it lists only what is still Off. Repeat until it says nothing is ready.

## 5. Verify

On the card the mode reads Released, the intended organizations are Issuing, and Ready is 0. Check Wallet copies and the check pill once more.

## Rollback

Rollback is draining, never straight to dark: the same one-cell PR and one-statement migration with `state = 'draining'`. Back to dark only once Wallet copies Open is 0. See [[Wallet Provider Flip Rollback]].
