---
tags: runbook, deploy, rename, production, cloudflare
confirm: true
cwd: ~/Repos/wallet
profile: passbook-owner
env:
  OLD_WORKER: wallet
  NEW_WORKER: passbook
  OLD_APPLE: apple-provisioner
  NEW_APPLE: passbook-apple-connector
  OLD_DB: wallet-platform
  NEW_DB: passbook-platform
  OLD_APPLE_DB: apple-provisioner
  NEW_APPLE_DB: passbook-apple-connector
  OLD_BUCKET: wallet-passes
  NEW_BUCKET: passbook-passes
  WORK: .wrangler/rename
---
# Worker Rename

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Renames the PassBook Workers and every Cloudflare resource tied to them to `passbook-*`: Workers `wallet` to `passbook` and `apple-provisioner` to `passbook-apple-connector`, D1 `wallet-platform` to `passbook-platform` and `apple-provisioner` to `passbook-apple-connector`, R2 `wallet-passes` to `passbook-passes`, queues `wallet-jobs`, `wallet-jobs-dlq`, `wallet-webhooks` to `passbook-*`, nine workflows, the `wallet_events` dataset. Cloudflare cannot rename any of these in place, so this copies the data across, proves it, and lets the merge (CI deploy) switch the code over. Plan, resource table and what is lost: `.wrangler/agent-logs/worker-rename-plan.md`. `passbook-id-connector` is not deployed and has no database yet: nothing to move. Its owner runbooks (`passbook-id-connector-*`) and the platform identity runbooks (`platform-identity-*`, `platform-keys`) already use the new names, including D1 `passbook-platform`; run them only after this cutover.

Production has no users, so the downtime from step 3 to the end of the CI deploy (20 to 40 minutes) is accepted. Lost: `ScanHub` Durable Object state, workflow instance history, Analytics Engine history, Worker version and log history, rate-limit counters. Every D1 row and R2 object is kept.

Order matters: a merge before step 4 passes fails closed (`deploy:check` refuses a placeholder D1 id or missing secrets and `wallet` keeps serving), but the domains would already be detached. Do not skip the freeze and copy.

Brought current with `main` on 2026-11-27 (branch `chore/worker-rename-refresh`). If `main` has moved since, merge it again before step 5 and check nothing new carries an old name.

```sh name=refresh-check confirm=no
git fetch origin main && git merge-base --is-ancestor origin/main HEAD && echo current || echo "main has moved: merge origin/main, run npm run gen"; git grep -n -E 'polaris-binding|apple-provisioner|wallet-(platform|passes|jobs|webhooks)' -- . ':!docs/runbooks/worker-rename*' ':!docs/audits' ':!docs/design' | head
```

Back out before the merge: the `norun` blocks in "Back out". Deleting the old resources is a separate note, [[Worker Rename Cleanup]], run days later.

## Prerequisites

- Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` (edit on Workers Scripts, Workers Routes and custom domains, D1, R2, Queues, Workflows) and `CLOUDFLARE_ACCOUNT_ID`.
- The same profile defines `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` (an R2 token with object read and write), `KEK_V1` (the value now in production: a different value makes sealed data unreadable), `TURNSTILE_SECRET`, `BREAKGLASS_TOKEN_SHA256`, `ASC_KEY_ID` and `ASC_ISSUER_ID`.
- Files outside the repo or git-ignored: `.secrets/platform-certificate.pem`, `.secrets/platform-key.pem`, and the App Store Connect `.p8` (set `ASC_KEY_FILE` below). The `.p8` goes only into `passbook-apple-connector` and the `iOS TestFlight` GitHub environment, nowhere else.
- `rclone` and `jq` are installed. The checkout is on branch `chore/worker-rename`, clean.
- The runbook folder is a Ledge workspace.

## Parameters

```sh name=set-params confirm=no
export ASC_KEY_FILE="${ASC_KEY_FILE:-}"
export CF="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_ENDPOINT="https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
mkdir -p "$WORK" && git rev-parse --abbrev-ref HEAD
```

The Cloudflare API helper reads the token from the environment, never from a command line.

```sh name=define-cf confirm=no
cf() { curl -fsS -K <(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN") "$@"; }
```

## 1. Preflight (read-only)

Both Workers exist and the new names are free.

```sh name=list-workers confirm=no
cf "$CF/workers/scripts" | jq -r '.result[].id' | grep -E '^(wallet|apple-provisioner|passbook.*)$'
```

```text
apple-provisioner
wallet
```

Record the old D1 row count of every table. This file is what the copy is checked against.

```sh name=count-old-db confirm=no
npx wrangler d1 execute "$OLD_DB" --remote --json --command "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\\' AND name NOT LIKE '\_cf\_%' ESCAPE '\\' ORDER BY name" | jq -r '.[0].results[].name' | awk '{printf "%sSELECT \"%s\" AS t, COUNT(*) AS n FROM \"%s\"", (NR>1 ? " UNION ALL " : ""), $1, $1}' > "$WORK/count.sql" &&
npx wrangler d1 execute "$OLD_DB" --remote --json --command "$(cat "$WORK/count.sql")" | jq -r '.[0].results[] | "\(.t)\t\(.n)"' | sort > "$WORK/db-old.tsv" &&
wc -l "$WORK/db-old.tsv"
```

```sh name=count-old-apple-db confirm=no
npx wrangler d1 execute "$OLD_APPLE_DB" --remote --json --command "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\\' AND name NOT LIKE '\_cf\_%' ESCAPE '\\' ORDER BY name" | jq -r '.[0].results[].name' | awk '{printf "%sSELECT \"%s\" AS t, COUNT(*) AS n FROM \"%s\"", (NR>1 ? " UNION ALL " : ""), $1, $1}' > "$WORK/count-apple.sql" &&
npx wrangler d1 execute "$OLD_APPLE_DB" --remote --json --command "$(cat "$WORK/count-apple.sql")" | jq -r '.[0].results[] | "\(.t)\t\(.n)"' | sort > "$WORK/apple-old.tsv" &&
cat "$WORK/apple-old.tsv"
```

Record the old bucket's object count and size.

```sh name=count-old-bucket confirm=no
rclone size --json "r2:$OLD_BUCKET" | tee "$WORK/bucket-old.json"
```

No workflow instance may be running (a running one is orphaned by the rename). Each line is a workflow with the count of running instances; all must be 0.

```sh name=workflows-running confirm=no
for w in template-import bulk-reissue broadcast pass-import identity-provision channel-apply connection-sync org-export org-purge; do printf '%s ' "wallet-$w"; cf "$CF/workflows/wallet-$w/instances?status=running&per_page=100" | jq '.result | length'; done
```

Queue backlogs now, for comparison after the freeze.

```sh name=queues-info-old confirm=no
for q in wallet-jobs wallet-jobs-dlq wallet-webhooks; do npx wrangler queues info "$q"; done
```

## 2. Create and prepare the new side

The main Worker and the connector get placeholder scripts so the secrets have somewhere to live (the docs do not say `wrangler secret put` creates a missing Worker). The CI deploy replaces the placeholder code and keeps the secrets.

```sh name=create-placeholder-workers confirm="Create empty placeholder Workers passbook and passbook-apple-connector in the production account?"
printf '%s' '{"main_module":"w.mjs","compatibility_date":"2026-08-14"}' > "$WORK/meta.json" && printf '%s' 'export default { fetch: () => new Response("moving", { status: 503 }) };' > "$WORK/w.mjs" &&
for w in "$NEW_WORKER" "$NEW_APPLE"; do cf -X PUT "$CF/workers/scripts/$w" -F "metadata=@$WORK/meta.json;type=application/json" -F "w.mjs=@$WORK/w.mjs;type=application/javascript+module" | jq -r '.success' || break; done
```

```sh name=put-secrets-main confirm="Set the five secrets on the passbook Worker?"
: "${KEK_V1:?add it to the profile}" && : "${TURNSTILE_SECRET:?add it to the profile}" && : "${BREAKGLASS_TOKEN_SHA256:?add it to the profile}" &&
printf %s "$KEK_V1" | npx wrangler secret put KEK_V1 --name "$NEW_WORKER" &&
printf %s "$TURNSTILE_SECRET" | npx wrangler secret put TURNSTILE_SECRET --name "$NEW_WORKER" &&
printf %s "$BREAKGLASS_TOKEN_SHA256" | npx wrangler secret put BREAKGLASS_TOKEN_SHA256 --name "$NEW_WORKER" &&
npx wrangler secret put SIGNER_PLATFORM_CERTIFICATE --name "$NEW_WORKER" < .secrets/platform-certificate.pem &&
npx wrangler secret put SIGNER_PLATFORM_PRIVATE_KEY --name "$NEW_WORKER" < .secrets/platform-key.pem
```

```sh name=put-secrets-apple confirm="Set ASC_KEY_P8, ASC_KEY_ID and ASC_ISSUER_ID on the passbook-apple-connector Worker?"
: "${ASC_KEY_FILE:?run set-params and set ASC_KEY_FILE}" && : "${ASC_KEY_ID:?add it to the profile}" && : "${ASC_ISSUER_ID:?add it to the profile}" &&
npx wrangler secret put ASC_KEY_P8 --name "$NEW_APPLE" < "$ASC_KEY_FILE" &&
printf %s "$ASC_KEY_ID" | npx wrangler secret put ASC_KEY_ID --name "$NEW_APPLE" &&
printf %s "$ASC_ISSUER_ID" | npx wrangler secret put ASC_ISSUER_ID --name "$NEW_APPLE"
```

Names only; both lists must show every required secret.

```sh name=secrets-verify confirm=no
npx wrangler secret list --name "$NEW_WORKER" --format json | jq -r '.[].name' | sort && npx wrangler secret list --name "$NEW_APPLE" --format json | jq -r '.[].name' | sort
```

```text
BREAKGLASS_TOKEN_SHA256
KEK_V1
SIGNER_PLATFORM_CERTIFICATE
SIGNER_PLATFORM_PRIVATE_KEY
TURNSTILE_SECRET
ASC_ISSUER_ID
ASC_KEY_ID
ASC_KEY_P8
```

Create the databases, queues and bucket. Put each printed database id in the matching `wrangler.jsonc` in the next block.

```sh name=create-databases confirm="Create D1 databases passbook-platform and passbook-apple-connector in the production account?"
npx wrangler d1 create "$NEW_DB" && npx wrangler d1 create "$NEW_APPLE_DB"
```

```sh name=create-queues confirm="Create queues passbook-jobs, passbook-jobs-dlq and passbook-webhooks in the production account?"
npx wrangler queues create passbook-jobs-dlq && npx wrangler queues create passbook-jobs && npx wrangler queues create passbook-webhooks
```

```sh name=create-bucket confirm="Create R2 bucket passbook-passes and its expire-uploads lifecycle rule?"
npx wrangler r2 bucket create "$NEW_BUCKET" && npx wrangler r2 bucket lifecycle add "$NEW_BUCKET" expire-uploads uploads/ --expire-days 1 && npx wrangler r2 bucket lifecycle list "$NEW_BUCKET"
```

Write the two database ids into the configs and commit on the branch. Both are looked up, not typed.

```sh name=record-db-ids confirm="Write the new D1 database ids into wrangler.jsonc and workers/passbook-apple-connector/wrangler.jsonc and commit them on this branch?"
export NEW_DB_ID=$(npx wrangler d1 info "$NEW_DB" --json | jq -r '.uuid // .id') && export NEW_APPLE_DB_ID=$(npx wrangler d1 info "$NEW_APPLE_DB" --json | jq -r '.uuid // .id') &&
: "${NEW_DB_ID:?not found}" && : "${NEW_APPLE_DB_ID:?not found}" &&
sed -i '' "s/\"database_id\": \"00000000-0000-0000-0000-000000000000\"/\"database_id\": \"$NEW_DB_ID\"/" wrangler.jsonc &&
sed -i '' "s/\"database_id\": \"00000000-0000-0000-0000-000000000000\"/\"database_id\": \"$NEW_APPLE_DB_ID\"/" workers/passbook-apple-connector/wrangler.jsonc &&
git add wrangler.jsonc workers/passbook-apple-connector/wrangler.jsonc && git commit -m "chore: record the passbook D1 database ids" && git show --stat --oneline HEAD
```

Deploy the connector now. The main deploy fails closed without it. Its database stays empty until step 4 imports the old one, tables and `d1_migrations` included.

```sh name=deploy-apple confirm="Deploy workers/passbook-apple-connector to production (replaces the placeholder)?"
npx wrangler deploy --config workers/passbook-apple-connector/wrangler.jsonc
```

## 3. Freeze the old Worker

The site is down from here. The list of detached domains is kept in `$WORK/domains.json` for backing out.

```sh name=save-domains confirm=no
cf "$CF/workers/domains?service=$OLD_WORKER" | jq '.result' > "$WORK/domains.json" && jq -r '.[] | .hostname' "$WORK/domains.json"
```

```text
passbook.mobile
wallet.plrs.im
developers.passbook.mobile
```

```sh name=detach-domains confirm="Detach passbook.mobile, wallet.plrs.im and developers.passbook.mobile from the wallet Worker (the site goes down)?"
: "$(jq 'length' "$WORK/domains.json")" && jq -r '.[].id' "$WORK/domains.json" | while read -r id; do cf -X DELETE "$CF/workers/domains/$id" | jq -r '.success'; done
```

```sh name=clear-old-crons confirm="Remove both cron triggers from the wallet Worker?"
cf -X PUT -H 'Content-Type: application/json' --data '[]' "$CF/workers/scripts/$OLD_WORKER/schedules" | jq -r '.success'
```

Wait for the old queues to empty. The consumers are still attached, so the backlog drains by itself; every backlog must read 0.

```sh name=queues-drained confirm=no
for i in $(seq 30); do for q in wallet-jobs wallet-jobs-dlq wallet-webhooks; do npx wrangler queues info "$q" | grep -i backlog; done; sleep 10; done; for q in wallet-jobs wallet-jobs-dlq wallet-webhooks; do npx wrangler queues info "$q"; done
```

A message left in `wallet-jobs-dlq` is dead work; look at it before the cleanup note deletes the queue.

## 4. Copy and prove

Export the old databases. The export blocks requests to them, which is fine while frozen.

```sh name=export-dbs confirm="Export wallet-platform and apple-provisioner from production D1 to $WORK?"
npx wrangler d1 export "$OLD_DB" --remote --output "$WORK/platform.sql" && npx wrangler d1 export "$OLD_APPLE_DB" --remote --output "$WORK/apple.sql" && ls -l "$WORK"/*.sql
```

```sh name=import-dbs confirm="Import the exports into passbook-platform and passbook-apple-connector?"
npx wrangler d1 execute "$NEW_DB" --remote --file "$WORK/platform.sql" && npx wrangler d1 execute "$NEW_APPLE_DB" --remote --file "$WORK/apple.sql"
```

Copy the bucket, server side, and recount.

```sh name=copy-bucket confirm="Copy every object from wallet-passes to passbook-passes?"
rclone copy "r2:$OLD_BUCKET" "r2:$NEW_BUCKET" --transfers 16 --checksum --stats-one-line
```

Prove it. Each diff must print nothing.

```sh name=prove-db confirm=no
npx wrangler d1 execute "$NEW_DB" --remote --json --command "$(cat "$WORK/count.sql")" | jq -r '.[0].results[] | "\(.t)\t\(.n)"' | sort > "$WORK/db-new.tsv" && diff "$WORK/db-old.tsv" "$WORK/db-new.tsv" && echo "platform: $(wc -l < "$WORK/db-new.tsv" | tr -d ' ') tables match"
```

```sh name=prove-apple-db confirm=no
npx wrangler d1 execute "$NEW_APPLE_DB" --remote --json --command "$(cat "$WORK/count-apple.sql")" | jq -r '.[0].results[] | "\(.t)\t\(.n)"' | sort > "$WORK/apple-new.tsv" && diff "$WORK/apple-old.tsv" "$WORK/apple-new.tsv" && echo "connector tables match"
```

```sh name=prove-bucket confirm=no
rclone size --json "r2:$NEW_BUCKET" > "$WORK/bucket-new.json" && diff <(jq -S . "$WORK/bucket-old.json") <(jq -S . "$WORK/bucket-new.json") && rclone check "r2:$OLD_BUCKET" "r2:$NEW_BUCKET" --one-way && echo "bucket matches"
```

The migrations table must be identical too (it is in the count files: `d1_migrations`), so CI applies nothing. This must print nothing pending.

```sh name=migrations-pending confirm=no
npx wrangler d1 migrations list "$NEW_DB" --remote
```

```sh name=deploy-check confirm="Read the Worker secret lists from Cloudflare (read-only) and run deploy:check --secrets?"
npm run deploy:check -- --secrets
```

```text
wrangler.jsonc is ready to deploy.
```

When this passes and every diff above was empty, tell the coordinator to merge `chore/worker-rename`. Push the branch first if the coordinator asks for the two id commits.

## 5. Merge and watch

CI deploys on the green `main` commit. It decides `--first` itself (new workflows, consumers, Durable Object namespace and domains), runs `wrangler deploy`, attaches the three domains and sets the crons, then smoke checks `https://passbook.mobile`.

```sh name=watch-deploy confirm=no
gh run list --workflow deploy --limit 3 && gh run watch "$(gh run list --workflow deploy --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

## 6. Verify

```sh name=verify-domains confirm=no
cf "$CF/workers/domains?service=$NEW_WORKER" | jq -r '.result[].hostname' | sort && cf "$CF/workers/domains?service=$OLD_WORKER" | jq -r '.result | length'
```

```text
developers.passbook.mobile
passbook.mobile
wallet.plrs.im
0
```

```sh name=verify-crons confirm=no
cf "$CF/workers/scripts/$NEW_WORKER/schedules" | jq -r '.result.schedules[].cron'
```

```text
* * * * *
17 3 * * *
```

Consumers must be the new Worker on the three new queues.

```sh name=verify-queues confirm=no
for q in passbook-jobs passbook-jobs-dlq passbook-webhooks; do npx wrangler queues info "$q"; done
```

```sh name=verify-workflows confirm=no
cf "$CF/workflows" | jq -r '.result[] | select(.script_name == "passbook") | .name' | sort
```

```sh name=verify-health confirm=no
for p in / /login /admin /developers /scan; do printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://passbook.mobile$p"; done; curl -s -o /dev/null -w 'wallet.plrs.im %{http_code}\n' https://wallet.plrs.im/
```

```text
/ 200
/login 200
/admin 200
/developers 200
/scan 200
wallet.plrs.im 308
```

Re-run `prove-db` and `prove-bucket`: after the first live writes the counts rise, but no table may be lower than the old count. Then by hand: sign in to `/admin`, open a pass and download its `.pkpass`, and send one test push.

## Back out (before the merge)

Re-attach the domains to the old Worker and restore its crons. The old D1 and bucket were never written, so nothing is lost. Not runnable from here on purpose.

```sh norun
jq -c '.[] | {hostname, zone_id, service: "wallet", environment: "production"}' "$WORK/domains.json" | while read -r body; do cf -X PUT -H 'Content-Type: application/json' --data "$body" "$CF/workers/domains"; done
cf -X PUT -H 'Content-Type: application/json' --data '[{"cron":"* * * * *"},{"cron":"17 3 * * *"}]' "$CF/workers/scripts/wallet/schedules"
```

After the merge, also revert it on `main` so the next deploy targets `wallet` again, and clear `passbook`'s domains first.

## Afterwards

[[Worker Rename Cleanup]] deletes the old Workers, workflows, queues, bucket and databases. Wait until the new side has run clean for several days.
