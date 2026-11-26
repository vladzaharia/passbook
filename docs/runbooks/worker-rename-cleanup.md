---
tags: runbook, deploy, rename, production, cloudflare, destructive
confirm: true
cwd: ~/Repos/wallet
profile: passbook-owner
env:
  OLD_WORKER: wallet
  OLD_APPLE: apple-provisioner
  OLD_DB: wallet-platform
  OLD_APPLE_DB: apple-provisioner
  OLD_BUCKET: wallet-passes
  WORK: .wrangler/rename
---
# Worker Rename Cleanup

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Deletes the old Workers `wallet` and `apple-provisioner`, their nine workflows, the three queues, the bucket `wallet-passes` and the two D1 databases, after [[Worker Rename]] moved everything to `passbook-*`. Everything here is destructive and cannot be undone, except a D1 database for 7 days (the undelete API). Run it only after the new side has served for several days with no rollback in sight.

Not deleted: the mTLS certificate `wallet-platform` (the APNs binding uses it by id), the `wallet_events` dataset (it expires by itself), the unrelated D1 `wallet` (6470925e), and every `pocket-id`, `polaris-*` and other Worker.

## Prerequisites

- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.
- `rclone` and `jq` are installed. `$WORK` still holds the old counts and the exports from the rename.
- Domains `passbook.mobile`, `developers.passbook.mobile` and `wallet.plrs.im` answer from `passbook`.

## Parameters

Set `RENAME_VERIFIED` to `yes` only after the checks below read as described. Every delete block refuses without it.

```sh name=set-params confirm=no
export RENAME_VERIFIED="${RENAME_VERIFIED:-}"
export CF="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_ENDPOINT="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
mkdir -p "$WORK"
cf() { curl -fsS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$@"; }
```

## 1. Checks (read-only)

The old Worker serves nothing: no domain, no schedule.

```sh name=check-old-idle confirm=no
cf "$CF/workers/domains?service=$OLD_WORKER" | jq '.result | length' && cf "$CF/workers/scripts/$OLD_WORKER/schedules" | jq '.result.schedules | length'
```

```text
0
0
```

The new Worker serves the site and the old bucket holds no object the new one lacks.

```sh name=check-new-serves confirm=no
curl -s -o /dev/null -w '%{http_code}\n' https://passbook.mobile/ && rclone check "r2:$OLD_BUCKET" r2:passbook-passes --one-way
```

Take a last export of both old databases for safekeeping, outside the repo, before they go.

```sh name=export-old-dbs confirm="Export wallet-platform and apple-provisioner once more to $WORK?"
npx wrangler d1 export "$OLD_DB" --remote --output "$WORK/platform-final.sql" && npx wrangler d1 export "$OLD_APPLE_DB" --remote --output "$WORK/apple-final.sql" && ls -l "$WORK"/*-final.sql
```

Keep those files somewhere safe (they hold production data), then set `RENAME_VERIFIED=yes`.

## 2. Delete

Workflows first, then queues, because the old Worker owns both.

```sh name=delete-old-workflows confirm="Delete the nine wallet-* workflows?"
: "${RENAME_VERIFIED:?set RENAME_VERIFIED=yes after the checks}" && [ "$RENAME_VERIFIED" = yes ] &&
for w in template-import bulk-reissue broadcast pass-import identity-provision channel-apply connection-sync org-export org-purge; do cf -X DELETE "$CF/workflows/wallet-$w" | jq -r '.success' || break; done
```

```sh name=delete-old-queues confirm="Delete the queues wallet-jobs, wallet-webhooks and wallet-jobs-dlq with whatever they still hold?"
[ "$RENAME_VERIFIED" = yes ] && for q in wallet-jobs wallet-webhooks wallet-jobs-dlq; do npx wrangler queues consumer remove "$q" "$OLD_WORKER" && npx wrangler queues delete "$q" || break; done
```

```sh name=delete-old-workers confirm="Delete the Workers wallet and apple-provisioner (their secrets go with them)?"
[ "$RENAME_VERIFIED" = yes ] && npx wrangler delete --name "$OLD_WORKER" --force && npx wrangler delete --name "$OLD_APPLE" --force
```

Deleting `wallet` also removes its `ScanHub` Durable Object namespace and storage.

```sh name=delete-old-bucket confirm="Empty and delete the R2 bucket wallet-passes?"
[ "$RENAME_VERIFIED" = yes ] && rclone purge "r2:$OLD_BUCKET" && npx wrangler r2 bucket delete "$OLD_BUCKET"
```

```sh name=delete-old-databases confirm="Delete the D1 databases wallet-platform and apple-provisioner?"
[ "$RENAME_VERIFIED" = yes ] && npx wrangler d1 delete "$OLD_DB" --skip-confirmation && npx wrangler d1 delete "$OLD_APPLE_DB" --skip-confirmation
```

## 3. Verify

Nothing named `wallet` or `apple-provisioner` is left among these. The unrelated D1 `wallet` may still list.

```sh name=verify-gone confirm=no
cf "$CF/workers/scripts" | jq -r '.result[].id' | grep -E '^(wallet|apple-provisioner)$'; npx wrangler queues list | grep -E 'wallet-'; npx wrangler r2 bucket list | grep -E 'wallet-passes'; npx wrangler d1 list --json | jq -r '.[].name' | grep -E '^(wallet-platform|apple-provisioner)$'; curl -s -o /dev/null -w 'site %{http_code}\n' https://passbook.mobile/
```

```text
site 200
```
