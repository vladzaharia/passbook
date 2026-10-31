# Audit F: code quality, structure, tests and developer tooling

Scope: `/Users/vlad/Repos/wallet` (read-only). All commands ran in a scratch copy with `.secrets/` and `.dev.vars` left out, at `/private/tmp/claude-501/-Users-vlad-Repos-wallet/aa819741-2eec-45f3-9bcd-5a212d436de3/scratchpad/run/wallet`, plus a fresh `git clone` of the new baseline commit (`.../scratchpad/run/clone`). Nothing in the project was modified. No secrets were read.

> **Note:** git was initialised while this audit was running. At 05:31 the coordinating session made commit `ea27ad5` ("Baseline: single-tenant wallet pass service…", 98 tracked files). The findings below apply to that commit.

---

## 1. Summary

1. **The code works and the tests are fast.** typecheck 1.6 s, unit/service tests 2.0 s (15/15 pass), workerd signer test 2.3 s, Playwright admin E2E 4.7 s, dry-run build 1.1 s. Testing focuses on behaviour (concurrency, outbox, signing, Apple protocol). Most of this is worth keeping.
2. **The code is not ready for many parallel agents.** There is no formatter or linter. Lines run up to 4,085 characters (490 lines exceed 120), and indentation mixes 1 and 2 spaces. A few hot files carry almost every change (`src/index.ts`, `src/types.ts`, `src/admin/client.ts`, `tests/service.test.ts`). Parallel edits would collide constantly.
3. **A fresh clone of the baseline commit is broken.** The user's global `~/.gitignore` has a `*.pem` rule, so `certificates/AppleWWDRCAG4.pem` is not in git. On a clone, `npm test`, `dev`, `build` and `test:runtime` all fail with ENOENT. Typecheck still passes.
4. **Several structural problems will hurt the multi-tenant build:**
   - 34 raw SQL statements across 4 files, none of them scoped to a tenant.
   - Domain code throws Hono `HTTPException`.
   - The `Env` type is hand-written with a `[k:string]:unknown` index signature.
   - Validation is hand-rolled, and the admin client's API types are duplicated by hand.
   - Henry's-specific logic leaks into generic routes, views and the studio.
   - Test fakes apply only `0001_initial.sql`.
5. **Recommended, in this order:** fix git ignores → one Biome reformat commit (with `.git-blame-ignore-revs`) → stricter tsconfig → `wrangler types` → pnpm monorepo with feature modules → zod + `@hono/zod-openapi` + Hono RPC → vitest (Node project + `@cloudflare/vitest-pool-workers` project) → `@playwright/test` → GitHub Actions CI.

---

## 2. What works well and should be kept

| Area | Evidence | Keep / evolve |
|---|---|---|
| **Fast feedback loop** | Full `check` takes about 7 s wall; the admin browser test takes 4.7 s (measured, §7) | Treat this as a budget. Agents will run checks constantly. |
| **Behaviour-level tests with meaningful names** | `tests/service.test.ts` covers concurrent writers (l.78-81), R2 failure leaving the previous version downloadable (l.83), stale-source fencing (l.134-140), APNs invalidation races (l.142-147), SQL wildcard literalness (l.38) and a tampered-manifest negative test (l.53) | Port these scenarios one-for-one. They encode real invariants. |
| **Real SQL in tests** | `tests/helpers.ts:9-23` runs the real migration in `node:sqlite` with BEGIN/COMMIT around batches | The idea is right (real SQL, not mocks). The vehicle should change to Miniflare D1 (§5). |
| **Real crypto end to end** | Per-run throwaway CA via `openssl` (`helpers.ts:32-39`); independent `openssl cms -verify` (`service.test.ts:52`); a separate workerd test (`scripts/test-runtime.ts`, `tests/runtime-worker.ts`) proves the signer works in the actual runtime | Keep the OpenSSL check as a Node-side test. |
| **Correctness-minded core** | CAS publish via `UPDATE … RETURNING` (`passes.ts:60`); R2 written before D1 publishes; trigger-based outbox (`migrations/0001_initial.sql:50-54`); leases and backoff (`jobs.ts:34,51`); idempotency keys (`index.ts:146-151`) | Keep the semantics and move them behind a repository layer. |
| **Security hygiene** | Constant-time compare (`util.ts:18-24`); prototype-key and protected-field guards (`personalize.ts:27-28`); bounded inputs; secret-free logs (`index.ts:36`, `jobs.ts:16,50`) | Turn these into written conventions. |
| **Extension seams already exist** | `PassTemplate` with `inputs` and `customize` (`types.ts:14-24`); `UpdateSource` and `httpJsonSource` (`src/sources/`); signing identities by name (`identity-names.ts`) | These are the seeds for `templates/<id>/` and `connectors/<type>/`. |
| **Lean, pinned dependencies** | 4 runtime deps, exact versions, lockfile v3 | Keep exact pins and add Renovate. |
| **Node native TS** | Tests and scripts run `.ts` directly with no tsx/ts-node; explicit `.ts` import specifiers | The code already passes `erasableSyntaxOnly` and `verbatimModuleSyntax` with **0 errors**. Turn both on to lock this in. |
| **Honest docs** | `docs/deployment.md` separates verified from unverified behaviour | Keep that style. |

---

## 3. Problems

Severity reflects impact on the planned multi-tenant, many-agent build, not only today's single-tenant service.

### 3.1 Repository and build hygiene

| # | Sev | Location | Problem | Why it matters |
|---|---|---|---|---|
| P1 | **High** | `/Users/vlad/.gitignore:45` (`*.pem`) vs `scripts/build-assets.mjs:11` | `certificates/AppleWWDRCAG4.pem` (public Apple WWDR cert) is not in commit `ea27ad5`. **Verified on a fresh clone:** `npm test` fails `ENOENT 'certificates/AppleWWDRCAG4.pem'`, `npm run test:runtime` fails `ENOENT public/templates/henrys/artwork.png`, typecheck passes. | Every agent worktree and every CI run starts broken. Fix: add `!certificates/*.pem` to the project `.gitignore` (repo patterns take precedence over `core.excludesFile`), then commit the file. |
| P2 | Medium | `package.json:21` | `test:runtime` doesn't run `assets` first, so it depends on `public/` (gitignored) from an earlier run. | It only works inside `npm run check` because of ordering. |
| P3 | Medium | `scripts/build-assets.mjs:16` (rm, then copy), `tests/service.test.ts:13,51-53`, `scripts/test-admin.mjs:8,35-71` | Tests write to fixed shared paths (`public/`, `src/generated/`, `artifacts/test-module.mjs`, `artifacts/test-manifest.json`, `artifacts/test-signature`, screenshots). `--test-concurrency=1` (`package.json:13`) is required. | Two agents running tests in the **same checkout** race (one does `rm -rf public/templates/x` while another's fake ASSETS reads it). Worktrees avoid this, but it is still a trap. |
| P4 | Low | `dist/` | Stale output from an earlier build: hashed PNG modules such as `*-thumbnail@2x.png` (current templates have no thumbnail). `--outdir dist` doesn't clean. | Confusing. It is ignored, so delete it. |
| P5 | Low | `artifacts/` (26 MB, ignored) | Mixes build intermediates, test scratch, real signed demo passes (`henrys-demo.pkpass`), screenshots cited by docs, and orphan bundles with no producer (`email-preview.mjs`, `views.mjs`). `docs/deployment.md` says "Screenshots are in artifacts/", but that path is not in git. | Split into `.cache/` or OS temp, `test-results/`, and `out/`. |
| P6 | Low | `src/generated/*.ts` (867 B, 942 B, 1.7 KB) | **Correction to the brief:** these are not large base64 maps. They are tiny path maps plus the WWDR PEM string. They are committed, while their sibling output `public/` is ignored. | Either is fine. Pick one rule: ignore them and generate in a `pre*` hook, or commit them and add a CI drift check (`git diff --exit-code` after `assets`). |
| P7 | Low | n/a | There is no `.gitattributes`, `.nvmrc`/`.node-version`, `.editorconfig`, `AGENTS.md`/`CLAUDE.md`, PR template or CI. Local Node is **v26.7.0** while `engines` says `>=24` and `@types/node` is 24. | Agents and CI will drift. |

### 3.2 Code style and readability

| # | Sev | Location | Problem |
|---|---|---|---|
| S1 | **High** | Whole codebase | Dense style with no tooling. src is 1,216 lines in 107 KB. 490 lines are over 120 characters and 104 are over 200. Max lengths: `views.ts:7` = **4,085** (inline CSS), `email.ts:16` = 1,773 (HTML email), `studio.ts` = 936, `client.ts:193` = 679, `service.test.ts:122` = 703. |
| S2 | Medium | `status.ts`, `views.ts`, all tests, most scripts vs the rest | **Inconsistent:** 1-space vs 2-space indentation; `import {a}` vs `import { a }`; spaced vs unspaced operators even within `util.ts`. The density is a habit, not a mechanical convention, so there is nothing to enforce. |
| S3 | Medium | `tests/service.test.ts` | Whole tests sit on one line with up to 8 assertions (e.g. l.49, 83, 87-88, 122). A failure's line number doesn't identify the assertion, and `let api:any` (l.10) means the tests are not type-checked against the code. |

**Assessment.** The dense style is compact enough for one author or one agent to hold in context. For parallel work it is a net negative:

- **Diffs and merges.** One edit rewrites a 300-character line, so two agents touching different statements on the same line always conflict.
- **Review.** GitHub and most review UIs truncate or wrap long lines, and `git blame` loses granularity.
- **Agent edits.** Exact-string Edit tools must match long unique substrings, and failures are more likely.
- **Debugging.** Stack-trace columns point into 300-character lines.

**Measured (Biome 2.6.4 trial on a scratch copy, 100 columns, 2 spaces, single quotes):**

| Scope | Lines before | Lines after |
|---|---|---|
| src | 1,216 | **2,676** (2.2×) |
| tests + scripts | 799 | 2,116 |
| `src/index.ts` | 211 | 381 |
| `src/admin/client.ts` | 281 | 918 |
| `tests/service.test.ts` | 147 | 600 |

Formatting completed in 12 ms. Biome `recommended` lint reported 7 errors, 60 warnings and 109 infos:

| Rule | Count | Note |
|---|---|---|
| `useTemplate` | 108 | |
| `noNonNullAssertion` | 29 | |
| `noExplicitAny` | 18 | |
| `noDescendingSpecificity` (CSS) | 7 | |
| `noControlCharactersInRegex` | 4 | Intentional; needs suppressions |
| `useIterableCallbackReturn` | 3 | |
| `noUnusedImports` | 2 | `index.ts:7` `baseURL`, `service.test.ts:9` `Env` |

oxlint 1.90 found 3 warnings, including `scripts/cloudflare.mjs:25` "body not allowed with GET" (it is always `undefined` for GET, so this is a false alarm).

### 3.3 Module structure and coupling

Current modules:

| Module | Responsibility | Coupling notes |
|---|---|---|
| `src/index.ts` (211 lines, 14 KB) | **God file.** Middleware (redirect, body limit, security headers), error mapping, 3 static-asset routes, 9 admin API routes including inline dynamic SQL for search/pagination (l.66-88), 5 Apple web-service routes, member download routes, handler exports | 13 of the 34 SQL statements live here. Every feature touches this file. |
| `src/types.ts` | Domain types, D1 row types, the hand-written `Env` | Every feature touches this too. |
| `src/passes.ts` | Build, sign, store, create/update with CAS, download response | Throws `HTTPException` (l.12,30,42,50,63). |
| `src/jobs.ts` | APNs push, outbox processing, source sync, cron dispatch, queue consumer | 11 SQL statements. |
| `src/sign.ts` | CMS/PKCS#7 signing, cert checks, zip | Clean and pure. Good package candidate. |
| `src/personalize.ts` | Input-schema validation and JSON-pointer/field-key mapping | Pure, but asserts via HTTP 400. |
| `src/status.ts` | Health/status aggregation | 4 SQL statements. Special-cases `membership-api` (l.46) and `Object.values(templates)[0]` (l.21). |
| `src/views.ts`, `src/studio.ts`, `src/email.ts` | HTML via template strings and manual `escapeHtml` | Henry's-specific: `views.ts:5,16`, `studio.ts:17,19,39` (hard-codes "Henry's Gymnasium", "Production wallet.plrs.im"). |
| `src/templates/*`, `src/sources/*` | Registries with hand-edited index files | Each new template or connector edits the shared `index.ts`. |
| `src/admin/client.ts` (281 lines, 26 KB) | The whole admin SPA: imperative DOM, string IDs, global mutable state (l.21-25) | API types re-declared by hand (l.1-9). Henry's field labels hard-coded (l.79, 96, 104-105, 172). |

| # | Sev | Location | Problem |
|---|---|---|---|
| M1 | **High** | `index.ts`, `jobs.ts`, `passes.ts`, `status.ts` | **34 raw `prepare()` calls with no data-access layer.** None take a tenant key. Adding `org_id` scoping later means finding every query by hand, and a single missed one is a cross-tenant leak. |
| M2 | **High** | `index.ts:77,86`; `views.ts:5,16`; `studio.ts:17,19`; `client.ts:7,79,96,104-105,172`; `status.ts:46` | **Tenant- and template-specific logic in generic code.** The list API projects `memberName`, `memberId` and `homeClub` from personalization, and search runs `json_extract` on Henry's fields. The member page and studio are hard-wired to Henry's. |
| M3 | Medium | `passes.ts:1,12…`, `templates/index.ts:6,11`, `util.ts:1-3`, `sources/index.ts:17-19` | **Domain code is coupled to HTTP.** `HTTPException` is thrown from domain and registry code, so queue and cron paths (`jobs.ts` → `findPass`/`getTemplate`) throw HTTP errors. Upstream payload validation in a connector raises "HTTP 400". |
| M4 | Medium | `index.ts:34` | `onError` maps **any** `SyntaxError` to "400 Malformed JSON", including `JSON.parse` of a corrupted DB column. |
| M5 | Medium | `jobs.ts:88-90` | The queue consumer swallows every error with no log (`catch { message.retry(...) }`) and treats any non-`outbox` kind as `sync`. Errors only get logged inside `processOutbox`. |
| M6 | Medium | `types.ts:38-51` | Hand-written `Env` has an `[binding:string]:unknown` index signature (needed for dynamic `SIGNER_*` and `apnsBinding` lookups). It drifts from `wrangler.jsonc`, a typo like `env.ADMIN_TOKN` type-checks, and `EMAIL` is a custom type instead of the runtime `SendEmail`. |
| M7 | Low | `index.ts:99,114,132,139,152` | Duplication: `waitUntil(dispatch(...).catch(...))` ×5. Also the serial regex (l.93/147), the "email configured" check (l.97/144), source parsing (l.95/127-129), `Math.floor(Date.now()/1000)` (`passes.ts:34,57`), hex digest (`sign.ts:57`, `runtime-worker.ts:17`), the identity regex (`identity-names.ts:2`, `import-credentials.mjs:8`), and the compat date (`scripts/test-runtime.ts:14` vs `wrangler.jsonc`). |
| M8 | Low | `scripts/package-template.mjs:4` | Hard-codes `['henrys','henrys-blue']`, whereas `build-assets.mjs:12` discovers templates. |
| M9 | Low | `views.ts:20` | Re-exports `studio` from `studio.ts`, an odd indirection. The member-page CSS is inlined in TS (l.7) while the admin CSS is a separate file. |

**Validation.** `util.ts` (`object`, `text`, `email`, `assert`) plus `personalize.validateInputs`, which interprets the template `InputField` mini-schema, are compact and safe, but:

- they produce no types for request bodies (everything is `Record<string,unknown>`);
- there is no OpenAPI;
- the admin client re-declares the same shapes by hand.

### 3.4 Tests

**Results (measured in the scratch copy):**

| Command | Result | Wall time |
|---|---|---|
| `npm run typecheck` | pass | 1.55 s |
| `npm test` (includes `assets`) | **15/15 pass** | 1.97 s (node:test reports 1.27 s) |
| `npm run test:runtime` (workerd) | pass | 2.32 s |
| `npm run test:admin` | pass (needed `PLAYWRIGHT_PACKAGE` pointed at a cached Playwright 1.63.0 in `~/.npm/_npx`) | 4.69 s |
| `wrangler deploy --dry-run --outdir dist` | pass; 970.6 KiB / 159 KiB gzip | 1.07 s |

Bundle composition: pkijs 625 KiB, asn1js 92 KiB, app code 81 KiB, hono 55 KiB. It is unminified because wrangler doesn't minify by default.

**Coverage.** Node's coverage can't see `src` by default. The bundle path `artifacts/test-module.mjs` matches Node's default `test-*` exclusion, and there is no sourcemap. With an inline sourcemap added in the scratch copy and default excludes overridden, coverage is about **76% lines / 71% branches / 79% functions**. Per file: `jobs.ts` 50% functions and 56% branches; `index.ts` 62% functions; `email.ts` 33% branches. These figures are approximate because esbuild sourcemaps mark declaration-only lines as uncovered.

**Untested (verified by grep):**

- `consume` (queue consumer), `dispatch` (exported to tests but never called), `scheduled`
- `POST /api/passes/:serial/sync` and `/deliveries/:id/retry`
- body-limit 413, security headers, the `ADMIN_TOKEN` < 32 → 503 path, email-not-configured 503
- `/admin/:asset`, `/apple/:asset`, `/brand/...`
- `signPass` featured-action validation and cert-expiry branches
- `httpJsonSource` size, redirect and content-type rejections
- all of `scripts/*.mjs` except `recordMatches` (provisioning and deploy, the code that touches prod)

| # | Sev | Location | Problem |
|---|---|---|---|
| T1 | **High** | `tests/helpers.ts:11` | The fake DB runs **only** `migrations/0001_initial.sql`. The first `0002_*.sql` will be silently missing from tests. |
| T2 | Medium | `helpers.ts:15-31` | The fakes diverge from production:<br>- `Statement` has no `raw()`, `meta.last_row_id` or `duration`.<br>- `meta.changes` is derived from `total_changes()`.<br>- Bucket `get().body` is a `Uint8Array`, not a stream, and httpMetadata is ignored.<br>- `list()` ignores options.<br>- The Queue fake has no `sendBatch` and no `MessageBatch`.<br>- ASSETS reads `public/` via `fs`.<br>Every new binding feature (KV, DO, Workflows, Secrets Store, D1 sessions) needs a new hand-written fake. |
| T3 | Medium | `service.test.ts:13-14` | Tests import an esbuild bundle (`artifacts/test-module.mjs`), not the source. The reason is that the JSON imports in `src/templates/henrys.ts:1` and `index.ts:2` lack `with { type: 'json' }`. **Verified:** adding the attribute lets Node import `src/index.ts` directly, and tsc and wrangler still pass. The bundle hides src from coverage, forces `api:any`, and uses a **different esbuild** (0.27.7 direct) from wrangler's (0.28.1 nested). |
| T4 | Medium | `scripts/test-admin.mjs` | One 74-line imperative script with no test runner. Playwright isn't a devDependency (`createRequire(process.env.PLAYWRIGHT_PACKAGE…)`, l.25). It waits on exact UI copy (`'Saved. Wallet update queued.'`, l.49) and writes screenshots into `artifacts/`. |
| T5 | Low | `service.test.ts:33` | Test data is cloned with raw `INSERT … SELECT` SQL instead of factories, so it breaks on any schema change. |
| T6 | Low | `tests/provision.test.ts:3` | `@ts-expect-error` to import a `.mjs`. Scripts are untyped (`tsconfig.json` includes only `scripts/**/*.ts`). |

### 3.5 Tooling and configuration

| # | Sev | Location | Problem |
|---|---|---|---|
| C1 | Medium | `tsconfig.json:7` | A single program uses `types: ["@cloudflare/workers-types","node"]` for Worker code, Node scripts and tests together, so Node-only APIs type-check in Worker code.<br>Missing strictness, with the error count each flag adds today (worker / admin):<br>- `noUncheckedIndexedAccess`: **32 / 5** (15 in tests)<br>- `exactOptionalPropertyTypes`: 2<br>- `noUnusedLocals`: 2<br>- `noImplicitReturns`: 1 (`index.ts:15`)<br>- `verbatimModuleSyntax`, `isolatedModules`, `erasableSyntaxOnly`: **0** (free to enable)<br>- `noPropertyAccessFromIndexSignature`: 81 / 19 (skip it) |
| C2 | Medium | `scripts/deploy.mjs:8`, `smoke.mjs:5`, `provision.mjs:7,56`, `live-check.mjs:11`, `browser-check.mjs:7` | `wrangler.jsonc` is parsed with `JSON.parse`, and `provision` rewrites it with `JSON.stringify`. The first comment anyone adds to this **JSONC** file breaks deploy, and provisioning strips comments. |
| C3 | Medium | `scripts/*.mjs` | The most dangerous code (provision, deploy, credentials, live checks) is untyped JS with one unit test. It also hard-codes single-tenant facts (`provision.mjs:9,15-16`: `henrys`, `plrs.im`, `wallet.plrs.im`). `check-dns.mjs:18-23` monkey-patches `dns.lookup` globally. |
| C4 | Medium | `package.json` deps | **Outdated** (npm registry, 2026-10-31):<br>- wrangler 4.116.0 → 4.156.0 (wrangler itself prints "update available")<br>- @cloudflare/workers-types 5.20261005.1 → 5.20261031.1<br>- TypeScript 5.9.3 → 7.0.2 (native compiler)<br>- pkijs 3.4.1 → **4.0.1** and asn1js 3.0.10 → **4.0.0** (majors, crypto-critical)<br>- esbuild 0.27.7 → 0.28.2<br>- hono 4.13.13 → 4.13.14<br><br>**Unused** (grep-verified):<br>- `sharp` 0.35.5: native, about 19 MB with `@img`, slows every worktree install<br>- `miniflare` 4.20260730.0: a transitive dependency of wrangler; pinning it directly causes duplicates when wrangler is upgraded |
| C5 | Low | `package.json:9` | `dev` builds assets once, so there is no watch or HMR for `src/admin/client.ts` or `studio.css`. Each change needs a manual `npm run assets`. |
| C6 | Low | `scripts/wrangler.mjs`, `cloudflare.mjs:4-6` | The wrapper only sets the log path and disables metrics. `npx wrangler` bypasses it. Acceptable, but these could be env defaults instead. |
| C7 | Low | `docs/extending.md` ("limits response bodies to 256 KiB") vs `src/sources/http-json.ts:20` (`256_000` bytes, about 250 KiB) | Small doc and code mismatch. Other doc claims checked (32 KiB body limit, 15-second timeout, 15 tests, last 20 deliveries, routes, scripts) match the code. |
| C8 | Info | `.secrets/`, `.dev.vars` in the repo root | They are ignored, which is fine. But with many agents having read access to the working tree, production credentials sit one `cat` away. Worktrees won't contain them, which is good. Consider moving them out of the tree. |

---

## 4. Not modern best practice (with modern alternative)

| Today | Modern alternative |
|---|---|
| No formatter or linter | **Biome 2.x** (format + lint + import sorting in one fast binary; `biome ci` in CI). Add type-aware no-floating-promises (Biome's `noFloatingPromises` rule, or oxlint `--type-aware`; *maturity unverified*). Unawaited promises are a classic Workers bug. |
| Hand-written `Env` + `@cloudflare/workers-types` | `wrangler types`: generates `worker-configuration.d.ts` (Env from `wrangler.jsonc` plus runtime types matching the compat date). Commit it and check for drift in CI. Model dynamic `SIGNER_*` lookups with a typed accessor instead of an index signature. |
| Hand-rolled validators, no API schema | **zod v4 + `@hono/zod-openapi`**: typed `c.req.valid()`, an OpenAPI 3.1 document for free, and **Hono RPC (`hc<AppType>`)** for the SPAs, so the API contract is compile-checked across worker and UI. Template input schemas: compile `InputField` into zod at runtime. For uploaded templates that carry JSON Schema, use `@cfworker/json-schema`, because Ajv relies on code generation that Workers forbid. |
| Raw SQL strings and `first<PassRow>()` casts | **Drizzle ORM (D1 driver) + drizzle-kit** writing SQL files into the wrangler migrations dir (or Kysely). The real reason is a **tenant-scoped repository** (`repo.forOrg(orgId)`) so unscoped queries can't be written. Keep the triggers and RETURNING via `sql`. |
| HTML via template strings and manual `escapeHtml` | **`hono/jsx`** (already in the dependency tree; escapes by default) for member pages and emails. |
| Imperative-DOM admin in one file | Vite SPA (framework is the owner's choice) + typed RPC client + query cache; **`@cloudflare/vite-plugin`** for one dev server with HMR for SPA + Worker. |
| node:test + hand fakes + esbuild bundle hack | **vitest** with two projects: Node (pure) and **`@cloudflare/vitest-pool-workers`** (integration in workerd). See §5.3. |
| Ad-hoc Playwright script via `PLAYWRIGHT_PACKAGE` | **`@playwright/test`** devDependency with `webServer`, role/label locators, `expect` auto-wait, traces on retry, `test-results/`. |
| Domain throws `HTTPException` | Typed `AppError` (`code`, `status`, `expose`) mapped once in `onError` to RFC 9457 `application/problem+json`. |
| `.mjs` ops scripts | `.ts` run by Node natively, included in a `tools` tsconfig. Parse `wrangler.jsonc` with a JSONC parser (`jsonc-parser`) and edit with `modify()` to keep comments. |
| npm, single package | pnpm workspaces. Its content-addressed store makes per-agent worktree installs fast; npm copies about 258 MB per worktree. |
| Engines field only | `.node-version` (24), `devEngines` in package.json. Pin pnpm via `packageManager`. Corepack is no longer bundled with recent Node (*verify for your Node version*). |
| Manual dependency bumps | Renovate with grouped `cloudflare` updates (wrangler, workerd, workers-types, vitest-pool-workers) and grouped `crypto` updates. |

---

## 5. Recommendations

### 5.1 Sequencing (do this before spawning parallel agents)

1. **Git hygiene** (one commit):
   - Add `!certificates/*.pem` to `.gitignore` and add `certificates/AppleWWDRCAG4.pem`.
   - Delete `dist/`; move test scratch output out of `artifacts/`.
   - Add `.gitattributes` (`*.png binary`, `src/generated/** linguist-generated`), `.node-version`, `.editorconfig`.
   - Verify with a fresh clone running `npm ci && npm run check`.
2. **Reformat commit** (one commit, nothing else in it): add `biome.json`, run `biome format --write` and `biome lint --write` with safe fixes only, then record the commit SHA in `.git-blame-ignore-revs`. Do this while **no branches are open**, otherwise every agent branch conflicts with it.
3. **Strictness commit:** enable `noUncheckedIndexedAccess` (fix 37 errors), `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`, `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`. Split tsconfigs (worker / node-tools+tests / browser) with a shared `tsconfig.base.json`. Switch to `wrangler types`.
4. **Test harness commit:** add JSON import attributes and drop the esbuild test bundle. Move to vitest (two projects) and port the 15 scenarios. Apply **all** migrations. Add `@playwright/test`.
5. **CI commit** (GitHub Actions, below).
6. **Restructure into the target layout (§5.4)** as a sequence of mechanical move PRs by one agent. Only then fan out.

### 5.2 Conventions (put these in `AGENTS.md`)

**Formatting**
- Biome: 100 columns, 2 spaces, single quotes, semicolons, trailing commas `all`.
- CI runs `biome ci`.
- Generated files are excluded via `files.ignore`.

**Files**
- kebab-case file names; named exports only (except the Worker entry); explicit `.ts` import specifiers; `import type` enforced.
- Soft limit of about 300 lines per file.
- Tests live next to the code as `*.test.ts`. Workers integration tests go in `apps/worker/test/`.

**Layering**
- `routes` (HTTP, validation, OpenAPI) → `service` (business rules, no Hono imports) → `repo` (the only place SQL or Drizzle appears).
- Every repo function is tenant-scoped: `repo.forOrg(orgId)`. Org-less access only through an explicitly named `systemRepo`.

**Errors**
- Throw `AppError` subclasses (`NotFound`, `Validation`, `Conflict`, `PreconditionFailed`, `Unauthorized`, `UpstreamFailed`) with stable `code`s.
- Map them only in `platform/errors.ts`; respond with problem+json.
- Queue handlers classify errors as retryable or permanent and always log `{event, code, jobKind, id}`.

**Validation**
- Every route declares zod schemas for params, query, body and response. No `c.req.json()` without a validator.

**Views**
- `hono/jsx` only. No string-concatenated HTML.

**Determinism**
- Inject `clock` and `ids` (random) through context so tests can control time. Today the backoff and lease code reads `Date.now()` directly.

**Logging**
- Use `platform/log.ts`: structured `{event, requestId, orgId}`. Never log personalization, emails, tokens or URLs containing capability tokens (the current rule, written down).

**Registries**
- Templates and connectors are discovered by codegen (`assets` writes `src/generated/templates.ts` and `connectors.ts`). Adding one never edits a shared index file.

**Migrations**
- One lane or agent owns `migrations/` at a time, or use a rule: "rebase and renumber before merge". Never edit a merged migration.
- CI applies all migrations to a fresh local D1.

**Git**
- One agent = one branch in its own worktree. Conventional Commits. Small PRs. CI must be green.
- Rebase rather than merge. Hot files (`app.ts`, `contracts/index.ts`, `package.json`, the lockfile) change in dedicated small PRs.

### 5.3 Test strategy

| Layer | Tool | What | Notes |
|---|---|---|---|
| Unit (pure) | vitest, `environment: node` | `packages/passkit` (personalize, validate, manifest, CMS sign, zip), connector mappers, DNS helpers | **Golden-file snapshots of `pass.json` per template** catch any mapping change in review. Keep the `openssl cms -verify` and tampering tests here. Generate the test CA once per run in `globalSetup`, or switch to JS cert generation (`@peculiar/x509`) to drop the openssl CLI dependency. |
| Integration (Worker) | **`@cloudflare/vitest-pool-workers`** (0.23.0 on npm; peer `vitest ^4.1`, so **pin vitest 4.x**, not 5) | All HTTP routes via `SELF.fetch` against real D1/R2/Queues/assets from `wrangler.jsonc`. Migrations via `applyD1Migrations` (fixes T1). Queue consumer via message-batch helpers. Cron via a scheduled controller. Per-test isolated storage. | Replaces `tests/helpers.ts` fakes and `scripts/test-runtime.ts` (signing then already runs in workerd). Override `APNS` (mTLS binding Miniflare can't emulate) and upstream APIs with a mock service binding or fetch mocking. *Email-binding emulation fidelity is unverified.* Expect a few seconds of extra startup per project. |
| Tenant isolation | same pool | A dedicated suite: org A cannot list, read, update, download or sync org B's objects, for each route. | Write it before the first multi-tenant feature lands. |
| E2E | `@playwright/test` | Admin, portal, member page, magic-link and OIDC flows (Pocket ID stubbed or run as a local container) | `webServer` = `wrangler dev`/vite with local D1, seeded through factories. `fullyParallel` with an org per test. No exact-copy waits: use roles and `toHaveText`. |
| Contract | vitest | Snapshot `openapi.json`; Apple web-service protocol tests stay frozen | Breaking API changes show up in PR diffs. |
| Live/smoke | existing scripts | Manual or on deploy only, never in PR CI | Keep the read-only discipline. |

**Fixtures:** `test/factories.ts` (`makeOrg`, `makeTemplate`, `makePass`, `makeDevice`) that go through repositories, not raw SQL. Fixture certs come from global setup. Recorded upstream payloads live in `connectors/<type>/fixtures/*.json`.

**Gates:** coverage reported via vitest v8 or istanbul. Add thresholds on `packages/passkit` and `modules/*/service.ts` first. Keep the whole PR suite under about 30 s.

### 5.4 Target directory layout (pnpm workspaces)

```
wallet/
├─ AGENTS.md  README.md  biome.json  tsconfig.base.json  pnpm-workspace.yaml  .node-version
├─ .github/workflows/ci.yml        # PR gate (below)
├─ apps/
│  ├─ worker/                      # the deployable Worker: API, Apple web service, queues, cron, assets
│  │  ├─ wrangler.jsonc  worker-configuration.d.ts (wrangler types)  vitest.config.ts
│  │  ├─ migrations/               # D1 SQL (drizzle-kit output or hand-written)
│  │  ├─ src/
│  │  │  ├─ index.ts               # export default { fetch, queue, scheduled }: ~20 lines
│  │  │  ├─ app.ts                 # new OpenAPIHono(); app.route('/api/passes', passes) …: 1 line per module
│  │  │  ├─ platform/              # errors.ts log.ts clock.ts ids.ts env.ts auth.ts tenant.ts security-headers.ts
│  │  │  ├─ modules/               # vertical slices: one agent per module
│  │  │  │  ├─ passes/             # routes.ts service.ts repo.ts schema.ts contracts.ts *.test.ts
│  │  │  │  ├─ templates/  orgs/  users/  auth/ (oidc.ts, magic-link.ts)  connections/
│  │  │  │  ├─ deliveries/ (outbox, email, apns)  sync/  status/  downloads/  portal-api/
│  │  │  │  └─ apple-web-service/  # /wallet/v1/*: frozen protocol surface, own tests
│  │  │  ├─ jobs/                  # queue router: kind → handler registered by modules; cron dispatcher
│  │  │  ├─ connectors/<type>/     # http-json/, memberspot/…: connector.ts schema.ts fixtures/ *.test.ts
│  │  │  ├─ templates/<id>/        # template.ts, <id>.pkpasstemplate/, preview.tsx (baked templates)
│  │  │  ├─ views/                 # hono/jsx layouts, member page, email templates
│  │  │  └─ generated/             # templates.ts connectors.ts asset maps (CI drift-checked)
│  │  └─ test/                     # pool-workers integration + tenant-isolation suites, factories.ts
│  ├─ admin/                       # Vite SPA → built into worker assets (/admin)
│  └─ portal/                      # Vite SPA (or SSR via worker) for end users
├─ packages/
│  ├─ passkit/                     # pure pass engine (sign.ts, personalize.ts, manifest, zip): no CF deps
│  ├─ contracts/                   # zod schemas + types shared by worker, admin, portal (or export AppType)
│  └─ ui/                          # optional shared components for admin + portal
├─ e2e/                            # @playwright/test specs + playwright.config.ts
├─ tools/                          # provision.ts deploy.ts credentials.ts live-check.ts (typed, jsonc-safe)
└─ research/memberspot/            # investigations: excluded from build, lint and tests
```

**Why this split:**
- Each **module**, **connector** and **template** is a separate directory an agent can own end to end (routes + service + repo + tests). Registries are generated, so the only shared hot spots are a one-line mount in `app.ts`, the migrations folder and `contracts`.
- `passkit` changes rarely and is security-critical. Isolating it as a pure package with golden tests protects it.
- Keep **one Worker** at first. Separate Workers per surface are possible later via service bindings (owner decision).
- Turborepo or Nx caching is unnecessary at this size; `pnpm -r --filter` is enough.

### 5.5 Tooling setup (concrete)

**package.json scripts (root):**

| Script | Command |
|---|---|
| `format` | `biome format --write .` |
| `lint` | `biome lint .` |
| `ci:lint` | `biome ci .` |
| `typecheck` | `tsc -b` (project references), or `pnpm -r typecheck` |
| `test` | `vitest run` (projects: passkit-node, worker-pool) |
| `test:e2e` | `playwright test` |
| `gen` | `pnpm -F worker assets && pnpm -F worker exec wrangler types` |
| `check` | `gen` → `ci:lint` → `typecheck` → `test` → `pnpm -F worker exec wrangler deploy --dry-run --outdir .cache/dist` |

**CI** (`.github/workflows/ci.yml`, on every PR):

1. checkout
2. `pnpm/action-setup` + `setup-node` (`.node-version`)
3. `pnpm install --frozen-lockfile`
4. `pnpm gen && git diff --exit-code` (generated drift)
5. `pnpm ci:lint`
6. `pnpm typecheck`
7. `pnpm test`
8. `npx playwright install --with-deps chromium && pnpm test:e2e` (cache browsers)
9. dry-run build and upload the bundle-size artifact

**Deployment.** Keep production deployment manual: either a `workflow_dispatch` job behind a GitHub Environment with required reviewers, or the existing `tools/deploy.ts`. Workers Builds only becomes viable after `deploy.mjs`'s secrets-file and custom-domain choreography is replaced with standard `wrangler deploy` plus `wrangler secret`/Secrets Store. Add a **staging** Worker with its own D1 and R2 for agent-driven verification.

**Dependency hygiene:**
- Remove `sharp` and `miniflare`.
- Bump wrangler and workers-types (or drop workers-types for `wrangler types`).
- Upgrade pkijs/asn1js 4.x in an isolated PR, gated by the workerd and OpenSSL tests.
- Evaluate TypeScript 7 (native) once Biome, vitest and the Hono type inference load are confirmed working. Faster `tsc` pays off for many agents. *Compatibility unverified.*
- Add the `minify: true` wrangler option (optional).

---

## 6. Open questions only the owner can answer

1. **Monorepo and package manager:** is pnpm workspaces acceptable, or must it stay npm-only?
2. **Deployables:** one Worker serving API + admin + portal + Apple web service, or separate Workers per surface (blast radius, independent deploys, separate hostnames)?
3. **Admin and portal frontend:** which framework (React/Preact/Solid/Svelte)? One SPA with role-based routing or two apps? Does the portal need SSR (magic-link landing, member pass pages)?
4. **Data layer:** Drizzle, Kysely, or raw SQL behind typed repositories? Tenancy model: a shared D1 with `org_id` columns, or a D1 database per organisation? This changes the repository API and test setup.
5. **Reformat timing:** OK to do the one-time Biome reformat (2.2× more lines) **now**, before any agent branches exist? Any appetite to keep the dense style anywhere?
6. **Hosting and CI:** where will the git remote live (GitHub?), and should CI be GitHub Actions or Workers Builds? Who may deploy production, and should there be a staging environment?
7. **Secrets location:** keep `.secrets/` and `.dev.vars` in the working tree (readable by every agent with repo access), or move them to a password manager or Secrets Store and deploy from CI only?
8. **Existing data compatibility:** must existing Henry's passes, serials, download URLs and `/wallet/v1` endpoints survive the rebuild unchanged? This determines whether a migration fixture suite and an API-compat contract test are required.
9. **Templates:** do baked template PNGs stay in git (11 MB today), with uploaded templates only in R2? Is the template `version` bump to stay manual?
10. **`investigations/memberspot`:** keep it in the main repo (as `research/`), or move it out?
11. **Quality gates:** desired coverage thresholds and a CI time budget? Is TypeScript 7 adoption in scope?

---

## 7. Verification log

| Check | Result | How |
|---|---|---|
| typecheck | pass, 1.55 s | scratch copy |
| `npm test` | 15/15 pass, 1.97 s | scratch copy |
| `test:runtime` | pass, 2.32 s | scratch copy |
| `test:admin` | pass, 4.69 s | `PLAYWRIGHT_PACKAGE` = `~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/package.json` (1.63.0) |
| dry-run build | pass, 1.07 s, 970.62 KiB / 159.08 KiB gzip | scratch copy, local only |
| Regenerated `src/generated`, `public/` | byte-identical to the project | `diff -r` |
| Fresh clone of `ea27ad5` | `npm test` and `test:runtime` fail with ENOENT (P1); typecheck passes | `git clone` into scratch |
| Stricter tsconfig flag error counts | see C1 | `tsc --<flag>` in scratch copy |
| Biome and oxlint trial | see S1 | `npx @biomejs/biome@2.6.4`, `npx oxlint@1.90.0` on a scratch copy |
| JSON import attributes | Node then imports `src/index.ts` directly; tsc and wrangler dry-run still pass | scratch copy only |
| Coverage | ~76% lines, approximate | scratch copy with inline sourcemap and default excludes overridden |
| Dependency versions | see C4 | `npm outdated` / `npm view`, 2026-10-31 |

**Unverified (marked in the text):**
- Biome `noFloatingPromises` maturity
- pool-workers email-binding fidelity and internal wrangler/miniflare coupling
- TypeScript 7 ecosystem compatibility
- Corepack bundling status
- production behaviour (not exercised, by design)
