---
tags: runbook, deploy, production, first
confirm: true
profile: passbook-owner
---
# Deploy First

Owner only. Agents never deploy or use `--remote` (AGENTS.md).

Use for the first deploy of the main Worker, and for any release that adds a queue consumer, a workflow or a Durable Object class (`ScanHub`). Cloudflare documents that `versions upload` fails for a Worker that was never deployed and cannot apply Durable Object class changes; queue consumers and workflows are registered by `wrangler deploy`. `--first` bookmarks D1, migrates, then runs `wrangler deploy`, which serves at once with no gradual promote. CI picks `--first` itself (`tools/deploy-needs-first.ts`); this note is the manual path.

Before the first deploy, finish [[Go-Live Provision]] (queues, R2, D1) and [[Go-Live Secrets]]. A database that still lacks `0029_org_memberships` is refused; production is past that.

## Prerequisites

Profile `passbook-owner` defines `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## 1. Check

```sh name=deploy-check confirm=no
npm run deploy:check -- --secrets
```

```sh name=full-check confirm=no
npm run check
```

## 2. Dry run

```sh name=deploy-first-plan confirm=no
npm run deploy -- --first
```

## 3. Apply

```sh name=deploy-first-apply confirm="Bookmark D1, migrate and run wrangler deploy for the main Worker in production (serves at once)?"
npm run deploy -- --first --apply
```

## 4. Verify the queue consumer

The Worker must appear as consumer of `wallet-jobs`.

```sh name=verify-consumer confirm=no
npx wrangler queues info wallet-jobs
```

Later releases use the default flow: [[Deploy]]. First admin and the device test: [[First Admin and Device Test]].
