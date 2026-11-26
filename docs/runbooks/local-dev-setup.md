---
tags: runbook, local, dev
---
# Local Dev Setup

Use to run PassBook on your machine with a local D1 and a mock Polaris ID. Touches only this checkout (`.dev.vars`, `.wrangler/`); nothing remote.

## 1. Install and fill local vars

`dev:vars` fills only what is missing: KEK, mock OIDC, fixture signer, `PUBLIC_BASE_URL`. It never overwrites, so an old `PUBLIC_BASE_URL` on another port needs a hand edit.

```sh name=install confirm=no
npm ci
```

```sh name=dev-vars confirm=no
npm run dev:vars
```

## 2. Apply migrations to the local D1

```sh name=db-local confirm=no
npm run db:local
```

## 3. Start the servers

Both commands run until stopped and would block the shared shell, so run each in its own terminal.

```sh name=dev-oidc norun
npm run dev:oidc
```

```sh name=dev-server norun
npm run dev
```

The app answers at `http://localhost:5173`, the mock Polaris ID at `:5174`.

## Real Pass Type ID certificate (optional)

Writes `.secrets/platform-{certificate,key}.pem` and `.dev.vars`. Neither is committed. Put the `.p12` password in the environment first (`P12_PASSWORD`), not on the command line.

```sh name=credentials-local confirm=no
: "${P12_PASSWORD:?export P12_PASSWORD first}" && npm run credentials -- Pass.p12
```

## Notes

- Local dev has no APNs binding and no Analytics SQL binding: push shows "unavailable", charts read D1.
- Demo data and screenshots: [[Local Demo Data and Visual Sweep]].
- Fake Google and Samsung wallets: [[Local Mock Wallets]].
- Tests: `npm run test:unit|worker|web`, `npm run test:e2e` (needs `npm run dev:vars` once), `npm run coverage`.
