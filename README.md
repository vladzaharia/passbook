# Wallet

Multi-tenant Apple Wallet pass platform on Cloudflare Workers. Spec: `docs/design/platform-architecture.md`. Rules for contributors and agents: `AGENTS.md`.

## Develop

```sh
npm ci
npm run dev:vars   # adds missing dev-only values to .dev.vars
npm run db:local   # apply migrations to the local D1
npm run dev:oidc   # mock Pocket ID on :5174 (second terminal)
npm run dev        # http://localhost:5173
npm run check      # lint, types, tests, build
```

`.npmrc` points `@polaris-key` at https://pkg.plrs.im/npm/polaris-key/.
