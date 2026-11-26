---
tags: runbook, local, dev, demo
---
# Local Demo Data and Visual Sweep

Use to seed the local app with demo orgs and passes, then screenshot every route. Local only. Needs `npm run dev` running ([[Local Dev Setup]]).

## Prerequisites

- The dev server is up on `PORT` below.
- `.dev.vars` holds a valid signing identity. The fixture one lasts 2 to 3 days. On "Incorrect or expired WWDR intermediate", delete its `SIGNER_PLATFORM_*` lines, run `npm run dev:vars`, restart the dev server.
- Sign-in mail is capped at 5 an hour per address, so rerun seeds an hour apart.

## Parameters

```sh name=set-params confirm=no
export DEV_URL="${DEV_URL:-http://localhost:5173}"
```

## 1. Seed demo data

Adds 3 orgs, about 45 passes, portal users, connections and API keys. It waits for the baked blueprints, then invites and signs in `demo.owner@example.com` (org_admin in every org; org work runs as them, since a platform admin without membership gets 404). It reads a token from `npm run breakglass`; pass `--url` for another port.

```sh name=seed-demo confirm=no
node tools/seed-demo.ts --url "$DEV_URL"
```

## 2. Sweep every route

Screenshots each route at 3 viewports and 2 themes into `.wrangler/visual-sweep/<run>/` with an `index.json` of console errors, failed requests and statuses. It signs in once per role and keeps state in `.wrangler/visual-sweep/state/`.

```sh name=visual-sweep confirm=no
node tools/dev/visual-sweep.ts --url "$DEV_URL" --routes tools/dev/visual-routes/admin.json,tools/dev/visual-routes/portal.json,tools/dev/visual-routes/public.json,tools/dev/visual-routes/scanner.json,tools/dev/visual-routes/scanning.json
```

Options: `--only <name>`, `--viewports desktop,tablet,mobile`, `--themes light,dark`, `--emails`.

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
