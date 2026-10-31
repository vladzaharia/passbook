# Wallet

Multi-tenant Apple Wallet pass platform on Cloudflare Workers (Hono API, React admin and portal).

| Doc | For |
|---|---|
| [docs/operations.md](docs/operations.md) | local dev, go-live, deploy, device test |
| [docs/api.md](docs/api.md) | machine API and API keys |
| [docs/extending.md](docs/extending.md) | add a template, behavior or connector |
| [docs/design/platform-architecture.md](docs/design/platform-architecture.md) | spec |
| [AGENTS.md](AGENTS.md) | conventions and ownership |

## Develop

    npm ci
    npm run dev:vars   # adds missing dev-only values to .dev.vars
    npm run db:local   # apply migrations to the local D1
    npm run dev:oidc   # mock Pocket ID on :5174 (second terminal)
    npm run dev        # http://localhost:5173
    npm run check      # gen, lint, types, tests, build

`.npmrc` points `@polaris-key` at https://pkg.plrs.im/npm/polaris-key/.
