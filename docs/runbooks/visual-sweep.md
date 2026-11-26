---
tags: runbook, visual-sweep, local
env:
  E2E_PORT: "5473"
  SEED_BREAKGLASS_TOKEN: wbg_e2e-breakglass-token
---
# Visual Sweep

Screenshots every route at three widths and two themes against a local e2e server with demo data, and writes one labelled contact sheet per route. Touches only this machine: the e2e server uses a throwaway local D1, mock OIDC and mock mail. `SEED_BREAKGLASS_TOKEN` is the e2e server's fixed local test value, not a secret.

## Prerequisites

Run from the repo root (or a worktree with `node_modules`). Admin sign-in is the mock OIDC the server starts (`e2e-admin`, `e2e-reviewer`). Sign-in mail is capped at 5 an hour per address, so reruns reuse the saved state in `.wrangler/visual-sweep/state/`.

## Parameters

`ROUTES` is a comma list of route files under `tools/dev/visual-routes/`. `ONLY` keeps routes whose name contains any comma-separated substring; leave it empty for all. `OUT` must be inside `.wrangler/`.

```sh name=set-params confirm=no
export ROUTES="${ROUTES:-admin,portal,public,scanner,scanning}" && export ONLY="${ONLY:-}" && export OUT="${OUT:-.wrangler/visual-sweep/run}" && export SWEEP_URL="http://localhost:$E2E_PORT"
```

## 1. Start the server

Builds the app, migrates a fresh local database and serves on `E2E_PORT` (OIDC on +1, wallets on +3). Runs in the background; the log is `.wrangler/sweep-server.log`. A cold start can take a few minutes.

```sh name=start-server confirm=no
mkdir -p .wrangler && (WALLET_E2E_PREVIEW=1 E2E_PORT="$E2E_PORT" nohup node tools/e2e-server.ts > .wrangler/sweep-server.log 2>&1 & echo $! > .wrangler/sweep-server.pid); for i in $(seq 120); do curl -fsS "$SWEEP_URL/health" > /dev/null && break; sleep 5; done; curl -fsS "$SWEEP_URL/health"
```

## 2. Seed

Adds 3 orgs, passes, templates released through a second reviewer, a webhook with deliveries, a platform key, a join link, Henry's scanning data and a paper pass. Safe to rerun.

```sh name=seed confirm=no
node tools/seed-demo.ts --url "$SWEEP_URL"
```

## 3. Sweep

Writes screenshots, `index.json` and `sheets/<route>.png` into `OUT`.

```sh name=sweep confirm=no
FILES=$(for r in $(echo "$ROUTES" | tr ',' ' '); do printf 'tools/dev/visual-routes/%s.json,' "$r"; done) && node tools/dev/visual-sweep.ts --url "$SWEEP_URL" --routes "${FILES%,}" ${ONLY:+--only "$ONLY"} --out "$OUT"
```

## 4. Open the sheets

One image per route: rows are themes, columns are viewports.

```sh name=open-sheets confirm=no
open "$OUT/sheets"
```

## 5. Check for misses

Lists shots that were skipped or carry a note, such as a click that found nothing.

```sh name=list-notes confirm=no
python3 -c "import json,sys; d=json.load(open(sys.argv[1]+'/index.json')); n=[s for s in d if s.get('note') or not s['file']]; print(len(d),'shots,',len(n),'with notes'); [print(s['name'],s['viewport'],s['theme'],s.get('note')) for s in n]" "$OUT"
```

## Stop

```sh name=stop-server confirm=no
kill "$(cat .wrangler/sweep-server.pid)" && pkill -P "$(cat .wrangler/sweep-server.pid)"; lsof -nP -iTCP:"$E2E_PORT" -sTCP:LISTEN
```
