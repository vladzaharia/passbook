# Business and partner audit — local verification

Audit environment: main worktree at `8f5bee0`; `node tools/e2e-server.ts` against fresh `.wrangler/e2e-state`, local D1, mock OIDC, fixture signer and local Vite/Worker at 5173. No real partner, upstream, recipient, wallet provider, production database or production email service was used. No secret/signature was printed or saved.

## Exercised local flows

| Journey / command | Observed | Limits |
|---|---|---|
| `env -u CI npx playwright test --project=setup` | 3/3 passed: real mock-OIDC admin/user sign-in and tenant seed. | Isolated local identities; no production login. |
| `env -u CI npx playwright test e2e/05-connections.spec.ts --project=e2e` | 4/4 passed including setup: create demo connection, test config, sync three records into passes, inspect run/health, update upstream fixture and resync existing passes. | The Demo connector uses deterministic local data, not an external CRM or upstream. It does not establish production workflow duration or rate behavior. |
| Local org-scoped `passes:read` + `passes:write` test-mode API key; POST create, GET by ID | Pass creation returned 201; detail returned 200 with matching test mode and org. | Synthetic pass, no `sendEmail`, only the local e2e database. Secret value was never output. |
| Reuse Idempotency-Key with deliberately changed request body | Returned 409. | Expected `IDEMPOTENCY_KEY_REUSED` behavior; not a failure. |
| Reuse Idempotency-Key with the same request body | Two responses returned 201 with the same pass ID. | Verifies documented idempotent resource reuse in this fixture; no delayed seven-day retention was exercised. |
| Local signed `webhook-push` connection; POST synthetic signed event to `http://localhost:5173/hooks/connections/{id}` twice | First delivery and duplicate each returned 202 `{accepted:true}`; subsequent connection GET omitted the generated webhook secret; `autoCreate:false`, so the event could not issue passes. | HMAC was generated locally and not printed. Acceptance/dedupe acknowledgement was checked; no partner network. Does not prove every accepted asynchronous item is applied or permanently recoverable. |
| Local API-key issue + connector UI test/sync | Successful developer/operator journey above; see focused end-to-end run. | Not a production tenant onboarding or commercial approval. |

## Browser and service caveats

The local application loaded the login route and showed a Turnstile/browser-verification error in the browser. This local widget behavior is not evidence about production Turnstile, hostname allowlists, WAF or Cloudflare account configuration.

The native iOS simulator run in the preceding platform audit opened the hosted production `/scan` pairing page while unpaired. There were **no production mutations, authenticated operations, real scans, or real delivery**. It was not used for this business integration smoke.

## Still not verified

- Outbound partner event delivery, webhooks/callbacks, provider SDKs or external system reconciliation.
- Live upstream/OAuth provider credentials, third-party API quotas, Cloudflare account entitlements, Apple/Google/Samsung issuer accounts, APNs, external email delivery, production IdP/WAF/Access or vendor response times.
- Partner roles/self-service, contractual terms, pricing/billing, support process/SLA, production incident notifications, coordinated D1/R2/KEK recovery, residency or regulatory adequacy.
- Tenant-administrator non-interference, cross-organization customer aggregation semantics at scale, and eventual consistency under concurrent production jobs beyond the existing source tests.

Source findings and proposed acceptance checks in the accompanying reports are not runtime results unless repeated above.
## Multi-tenant customer-account smoke

Temporary worker test command: `npm run test:worker -- src/worker/modules/me/audit-multitenant-customer.test.ts`.

Result: **1 test passed**. Created two organizations with distinct passes, attached both passes to one synthetic customer account to represent the post-verification ownership state, and attached a third pass to a different customer. The real `/api/v1/me/passes` route returned both cross-org passes with their correct organization names and excluded the unrelated holder's pass. The temporary test file was removed after execution.

Fixture boundary: an initial E2E HTTP attempt created both passes using the mock user's `user@example.test` address, but neither pass was attached; inspection confirmed the local mock account email was not verified. This is the expected ownership proof gate, not a cross-tenant failure. The local owner-assignment smoke validates customer aggregation *after* the account-link transition; it does not exercise email-link verification or partner-issued customer consent.

The separate general audit records scoped-key isolation: the Alpha org key listed only Alpha's pass and received 404 for Beta's pass. The business smoke also validated cross-org customer aggregation with the platform's intentional holder principal. Neither test establishes organization-admin RBAC, which remains a distinct requested design boundary.
