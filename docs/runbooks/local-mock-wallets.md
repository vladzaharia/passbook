---
tags: runbook, local, dev, wallets
---
# Local Mock Wallets

Use to run the fake Google and Samsung wallets (`test/mock-wallets`) for dev and e2e. In-memory state, a request log and failure injection. Local only: never set `WALLET_MOCK_PROVIDERS_URL` in `wrangler.jsonc` or a deployed secret (a test fails if it appears there).

## Parameters

```sh name=set-params confirm=no
export MOCK_URL="${MOCK_URL:-http://localhost:5175}"
```

## 1. Start the fake

Either runs until stopped, so use its own terminal. The first also starts the app.

```sh name=start-with-dev norun
WALLET_MOCKS=1 npm run dev
```

```sh name=start-alone norun
node test/mock-wallets/server.ts 5175
```

When running alone, point `WALLET_MOCK_PROVIDERS_URL` at it.

## 2. Inspect

```sh name=mock-state confirm=no
curl -s "$MOCK_URL/__mock/state"
```

```sh name=mock-requests confirm=no
curl -s "$MOCK_URL/__mock/requests"
```

## 3. Inject a failure

`match` is a regex over `METHOD /path`; `status` is 200 to 599. This fails the next two token calls with a 429.

```sh name=mock-inject confirm=no
curl -s -XPOST "$MOCK_URL/__mock/inject" -d '{"status":429,"match":"POST /token","times":2,"retryAfterSeconds":5}'
```

## 4. Set a Samsung template

```sh name=mock-samsung-template confirm=no
curl -s -XPOST "$MOCK_URL/__mock/samsung-template" -d '{"cardId":"c1","template":{"cardType":"loyalty"}}'
```

## 5. Reset

```sh name=mock-reset confirm=no
curl -s -XPOST "$MOCK_URL/__mock/reset"
```

## Reference

- Google: `/token`, `/walletobjects/v1/{genericClass,genericObject,issuer}`, `/gp/v/save/<jwt>` (open it to record a save). Samsung: `/partner/v1/card/template/<cardId>` and `/<cc2>/wltex/cards/<cardId>/{updates,cancels}`. Signatures are not verified.
- The Worker redirects provider calls only when `WALLET_MOCK_PROVIDERS_URL` and `PUBLIC_BASE_URL` are both plain-http loopback.
- Run the e2e suite with both providers open against the fake: `npm run test:e2e:wallets` (see `docs/design/wallet-providers/e2e-release.md`).
