---
tags: runbook, local, dev, demo
env:
  E2E_PORT: "5473"
  SEED_BREAKGLASS_TOKEN: wbg_e2e-breakglass-token
---
# Local Demo Data and Visual Sweep

Use to seed a local e2e server with demo orgs and passes, then screenshot every route with one labelled contact sheet per route. Local only: the e2e server uses a throwaway local database, mock OIDC and mock mail. `SEED_BREAKGLASS_TOKEN` is that server's fixed test value, not a secret.

## Prerequisites

- Run from the repo root or a worktree with `node_modules`.
- Admin sign-in is Polaris ID in production, so the seed and sweep sign in through the mock OIDC the e2e server starts (`e2e-admin`; `e2e-reviewer` approves template releases).
- Sign-in mail is capped at 5 an hour per address. The sweep keeps its state in `.wrangler/visual-sweep/state/`, so reruns reuse it.

## Parameters

`ROUTES` lists route files under `tools/dev/visual-routes/`. `ONLY` keeps routes whose name contains any comma-separated substring; empty means all. `OUT` must be inside `.wrangler/`.

```sh name=set-params confirm=no
export DEV_URL="${DEV_URL:-http://localhost:$E2E_PORT}" && export ROUTES="${ROUTES:-admin,portal,public,scanner,scanning}" && export ONLY="${ONLY:-}" && export OUT="${OUT:-.wrangler/visual-sweep/run}"
```

## 0. Start the e2e server

Builds the app, migrates a fresh local database and serves on `E2E_PORT` (mock OIDC on +1, wallets on +3), in the background. The log is `.wrangler/sweep-server.log`. A cold start can take a few minutes.

```sh name=start-server confirm=no
mkdir -p .wrangler && (WALLET_E2E_PREVIEW=1 E2E_PORT="$E2E_PORT" nohup node tools/e2e-server.ts > .wrangler/sweep-server.log 2>&1 & echo $! > .wrangler/sweep-server.pid); for i in $(seq 120); do curl -fsS "$DEV_URL/health" > /dev/null && break; sleep 5; done; curl -fsS "$DEV_URL/health"
```

## 1. Seed demo data

Adds 3 orgs, about 45 passes, portal users, connections and API keys, templates released through a second reviewer, a webhook with deliveries, a platform key, a join link, Henry's scanning data and a paper pass. Safe to rerun.

```sh name=seed-demo confirm=no
node tools/seed-demo.ts --url "$DEV_URL"
```

## 2. Sweep every route

Screenshots each route at 3 viewports and 2 themes into `$OUT` with an `index.json` of console errors, failed requests and notes, and `sheets/<route>.png`: the six panels of a route in one labelled image. Other options: `--viewports desktop,tablet,mobile`, `--themes light,dark`, `--emails`.

```sh name=visual-sweep confirm=no
FILES=$(for r in $(echo "$ROUTES" | tr ',' ' '); do printf 'tools/dev/visual-routes/%s.json,' "$r"; done) && node tools/dev/visual-sweep.ts --url "$DEV_URL" --routes "${FILES%,}" ${ONLY:+--only "$ONLY"} --out "$OUT"
```

Open one image per route:

```sh name=open-sheets confirm=no
open "$OUT/sheets"
```

Lists skipped shots and notes, such as a click that found nothing:

```sh name=list-notes confirm=no
python3 -c "import json,sys; d=json.load(open(sys.argv[1]+'/index.json')); n=[s for s in d if s.get('note') or not s['file']]; print(len(d),'shots,',len(n),'with notes'); [print(s['name'],s['viewport'],s['theme'],s.get('note')) for s in n]" "$OUT"
```

A run with `scanning.json` also adds `scanner.json` (the `scan-unpaired` screens); no flag needed.

## 3. Scanner devices (optional)

Adds the paired device views (door, operator, desk, customer, staff sign-in, offline), the monitor and the customer display. Run it into the same folder as the sweep after the seed.

```sh name=visual-scan-devices confirm=no
node tools/dev/visual-scan-devices.ts --url "$DEV_URL" --out .wrangler/visual-sweep/scanning
```

## 4. Journeys (optional)

Follows one thing through several screens, emails included, at 390, 820 and 1440 wide, light and dark. Each run makes its own passes and ends by revoking its keys. A journey is `tools/dev/visual-journeys/<name>.ts`, registered in `index.ts`.

```sh name=visual-journeys confirm=no
node tools/dev/visual-sweep.ts --url "$DEV_URL" --journeys all
```

Output: `.wrangler/visual-sweep/journeys/<name>/` with numbered shots and an `index.html` in step order.

## Stop the server

```sh name=stop-server confirm=no
kill "$(cat .wrangler/sweep-server.pid)" && pkill -P "$(cat .wrangler/sweep-server.pid)"; lsof -nP -iTCP:"$E2E_PORT" -sTCP:LISTEN
```
