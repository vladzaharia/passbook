# e2e release: Google and Samsung against the mock wallets

Google and Samsung are dark in two places:

- `RELEASE` in `release.ts` (read by `provider-policy.ts`), a code constant per provider and mode;
- the `wallet_provider_releases` rows (migration `0226`), which the database's issuance guards read: they refuse
  any provider instance, activation, offer or Samsung reference of a provider and mode that is not `released`.

Worker tests open both in-process: `setWalletReleaseForTest` (or `setWalletProvidersEnabledForTest`), plus a row
write or `DROP TRIGGER` in the file's own database. The e2e server is another process, so until CW12 no browser spec could reach a save link, an edit, a
message or a void. The e2e release opens both for one local server, and only there.

## How it opens

- **Flags.** `src/worker/index.ts` calls `openE2eRelease()` (`wallet-providers/e2e-release.ts`) once, when the
  Worker module loads. If every signal below holds, it opens both providers in both modes for the isolate,
  through the existing test setter. If any signal fails, it logs `wallet.e2e_release_refused` and changes nothing.
- **Database.** `tools/e2e-server.ts` sets every `wallet_provider_releases` row to `released` (`E2E_RELEASE_SQL`,
  `tools/lib/e2e-release.ts`) after it migrates its throwaway database, so the guards run with their real bodies.
  It does this with `wrangler d1 execute --local`, and only for a release run.

| # | Signal | Set by | Never present in production because |
| --- | --- | --- | --- |
| 1 | Build define `__WALLET_E2E_RELEASE__ === true` | `vite.config.ts` via `e2eReleaseDefine`, only with `WALLET_E2E=1` and `WALLET_E2E_RELEASE=1`. Only `tools/e2e-server.ts` sets both. | `npm run build` (the CI deploy and the manual recipe) defines it `false`. The minifier then folds `openE2eRelease` to `return false` and drops the module. |
| 2 | `WALLET_E2E_RELEASE=1` at runtime | The e2e vars file `.dev.vars.e2e`. Only an e2e release build declares the var. | `wrangler.jsonc` never declares it (`e2e-release.test.ts`). A deployed Worker gets no `.dev.vars`. |
| 3 | `WALLET_MOCK_PROVIDERS_URL` and `PUBLIC_BASE_URL` are plain-http loopback | The e2e vars file | `PUBLIC_BASE_URL` is `https://passbook.mobile` in `wrangler.jsonc`, and the mock var is never declared there (`mock-endpoint.test.ts`). The same predicate (`mockProvidersUrl`) sends every provider call to the mock, so an opened server cannot call Google or Samsung. |
| 4 | No real credentials: the platform pass certificate and its chain come from the throwaway fixture CA (`Wallet Test WWDR`) and name no Apple entity | `createFixtureIdentity()` in `tools/e2e-server.ts` | A production Worker signs with an Apple-issued certificate and leaves `SIGNER_PLATFORM_INTERMEDIATE` unset, so it uses Apple's bundled WWDR G4. |
| 5 | Every `wallet_provider_releases` row is `released` | `tools/e2e-server.ts` for a release run, on `.wrangler/e2e-state` | Migrations seed them `dark`. Releasing one in a deployed database takes a flip migration that changes `RELEASE` too (check-migrations), one provider and mode at a time: the owner's go-live step (`docs/operations.md`, Wallet release). |

## Mock routing, not release

These changes behave the same in production, because they act only where signal 3 holds:

- **Credential checks and Samsung card reads.** `account-check-google.ts`, `account-check-samsung.ts` and
  `samsung-verification.ts` now fetch through `providerFetch`, as runtime calls already did through `runtime-core.ts`.
  Before, they called the real hosts even in dev.
- **Google callback URL.** `googleCallbackUrl` accepts the plain-http origin only while `mockProvidersUrl` holds.
  Anywhere else it still requires https.

## Why the bundle cannot carry it

- **Build.** `tools/check-bundle.ts` runs as part of `npm run build`. It scans every script and config file in
  `dist/wallet` and fails if any contains `WALLET_E2E_RELEASE` or `Wallet Test WWDR`. The first string also catches
  a define that was never replaced. The check also fails when there is no Worker script to scan.
  It skips `.map` files on purpose: the uploaded source map lists `e2e-release.ts` with its source, which is never
  executed. Do not widen the scan to source maps, or every production build fails.
- **Deploy.** `tools/deploy.ts --apply` refuses a `dist/` whose Worker carries a marker (`buildProblem`). This is in
  addition to the build stamp, which already refuses e2e builds because their rate limits are raised.
- **Proof.** `tools/lib/e2e-release.test.ts` bundles the Worker's own call with Vite twice.
  - With the production define, the output has no marker.
  - With the e2e define, it has both markers, so the scan can see the path.
  - The same file also checks that the release write names the table the migrations create.
- **Runtime.** `e2e-release.test.ts` shows each signal refusing on its own. It also shows that a build without the
  define cannot open the providers, even with every runtime signal present. The dark-gate tests in
  `provider-policy.test.ts` are unchanged.

Each layer stands alone. Opening the providers in production would need all of these at once:

1. a build with the e2e define;
2. a deploy that skips both the stamp and the scan;
3. an http loopback public origin with a declared mock URL;
4. a fixture-CA signer;
5. a migration that releases the provider in `wallet_provider_releases`.

Even then, every provider call would go to a loopback mock that a deployed Worker cannot reach
(`global_fetch_strictly_public`).

## Running

    npm run test:e2e:wallets            # playwright.wallets.config.ts starts the server with WALLET_E2E_RELEASE=1

- The main run (`npm run test:e2e`) ignores `*-wallets-*` specs and keeps the providers dark, as in production.
- `auth.setup.ts` checks that the server matches the run (`e2eReleaseMismatch`): the wallets run needs both providers
  open, every other run needs both dark. A server reused from the other kind of run fails at once, with a clear message.
- What runs today and what is still open: `architecture.md` section 8, "CW12 status".
