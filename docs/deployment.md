# Deployment to wallet.plrs.im

## Current status

Deployed on 2026-10-30 (America/Los_Angeles):

- Two native Henry’s templates, original artwork, Code 39, classic fallback, and per-home-gym native Maps actions.
- Pass Type ID `pass.com.henrysgymnasium.member`, team `48H7CLBV8Y`.
- Existing passwordless Henry’s p12 imported locally; private key and certificate match.
- Correct Apple WWDR **G4** intermediate verified and included in signatures.
- Signing certificate expires **2027-11-29 22:34:06 UTC**.
- D1 migration, provisioning/deployment commands, studio, issuance, signing, download, email, device registration, APNs delivery, and pluggable API polling implemented.
- Worker and browser TypeScript checks, 15 service/DNS tests, actual workerd signing test, and Worker dry run pass. The SQL test fixture includes D1's trigger writes in `meta.changes`; publication uses `UPDATE ... RETURNING` for optimistic concurrency.
- Both standalone samples and the live download independently verify with OpenSSL against WWDR G4.
- Playwright verified desktop/mobile studio layouts, admin authentication, creation with email, saved-pass browsing, and the private member page. Screenshots are in `artifacts/`.
- Cloudflare accepted the test email to the explicitly authorized recipient on the first attempt, with its `.pkpass` attachment and private link. Inbox receipt is not inferred from provider acceptance.
- Live Wallet registration, changed-serial cursor, pass updates with stable authentication, signed refetch, HTTP 304, and unregister passed.
- APNs production mTLS transport passed: Apple returned an invalid-token response for the deliberately invalid test token, and the service removed that test registration. Workers outbound requests use `redirect: 'manual'` and reject redirects by response status; the edge runtime does not support `redirect: 'error'`.
- The admin panel has a full-width pass table, server-side search and filters, and a side editor with Details, Delivery, and Updates tabs. Local browser checks cover creation, editing, version conflicts, unsaved-change protection, delivery refresh, source setup, and mobile layouts. Removing `crypto.randomUUID` before page load verifies the secure fallback for pass IDs and email retry keys. Live browser checks are read-only.

The Worker, D1 migration, private R2 bucket, queues, Cron trigger, email binding, signing secrets, APNs mTLS certificate, and HTTPS custom domain are deployed. Public DNS-over-HTTPS resolves the hostname and TLS validation passes. This workstation initially retained a negative DNS cache, so browser/live tests used the publicly resolved address while preserving the hostname and TLS checks.

Physical iPhone installation/rendering, actual push receipt, and gym reader scanning remain device acceptance checks. A real gym API has not been configured; the adapter interface and example polling source are ready.

## Provision and deploy

Use a session where Wrangler and Node can access the Cloudflare API. The zone must be in the selected Cloudflare account. Workers Paid and access to Cloudflare Email Sending are needed for delivery to ordinary recipients. Account entitlement and DNS verification are checked during provider onboarding; this code does not change the account's billing plan.

```sh
npx wrangler login
npm run provision
npm run deploy
```

The refreshed Wrangler OAuth login successfully provisioned these resources. Alternatively, supply `CLOUDFLARE_API_TOKEN` securely through the environment, scoped to the account and `plrs.im` zone: Workers scripts/domains, D1, R2, Queues, mTLS certificate management, Zone read, and Email Sending management. DNS edit is needed only when missing email DNS records must be created. Product API permission names are shown in the linked Cloudflare API references.

The original HTTP 403 / code 10000 came from querying general zone DNS with Wrangler OAuth, which lacks that permission. Provisioning now checks public email DNS first and reuses the already-verified `plrs.im` sender domain. Custom-domain setup uses the Workers domain API. It does not require broader DNS credentials for this deployment.

`provision` obtains the account from the zone and reuses named resources when present:

| Resource | Name |
| --- | --- |
| Worker / custom domain | `wallet` / `wallet.plrs.im` |
| D1 | `wallet` |
| Private R2 bucket | `wallet-passes` |
| Queue / dead-letter queue | `wallet-jobs` / `wallet-jobs-dlq` |
| mTLS binding | `APNS` with Henry’s pass certificate and key |
| Email Sending domain | `plrs.im` (existing, verified) |
| Allowed sender | `passes@plrs.im` |

It refuses an existing hostname owned by another Worker or conflicting DNS records. Existing compatible email DNS, including extra DMARC reporting tags, is preserved. Missing records are created only with suitable DNS access; otherwise `artifacts/required-email-dns.json` gives the exact records to configure. It writes real D1 and mTLS IDs into `wrangler.jsonc`. Provider onboarding progress is kept under ignored `.secrets/` so failures can be diagnosed and the command rerun.

`deploy` validates provisioning and certificate lifetime, runs local checks, applies remote D1 migrations, and publishes secrets with the same Worker version as the code using Wrangler's `--secrets-file`. The temporary secret/config files are removed afterward. It publishes the custom domain separately with DNS and existing-origin overrides disabled, then checks HTTPS health, admin protection, template metadata, D1 access, and artwork. A newly created custom domain may need time for DNS/TLS; rerun `npm run deploy:check` after it becomes active. A final smoke-test failure does not roll back an otherwise successful deployment.

If this execution environment restricts Wrangler's default log directory, set `WRANGLER_LOG_PATH=/private/tmp/wallet-wrangler.log`. This fixes log writes only; it does not grant network access.

## Certificates and secrets

The p12 supplies the Pass Type ID certificate and private key. Apple requires the matching WWDR intermediate in the CMS signature. `certificates/AppleWWDRCAG4.pem` is a public certificate copied from the installed Apple Pass Designer app and verified against the leaf issuer. Other WWDR generations are not interchangeable.

The **same pass certificate and private key** authenticate production Wallet push requests through the Workers mTLS binding. App Store Connect API credentials, app distribution certificates, and unrelated APNs keys are not needed for this service and were not uploaded. No Apple app or App Store release is required.

Each signing identity uses separate PEM secret bindings: `SIGNER_HENRYS_CERTIFICATE` and `SIGNER_HENRYS_PRIVATE_KEY` (PKCS#8). This keeps each value under Cloudflare's 5 KiB limit. The public WWDR G4 intermediate is baked into the Worker; `SIGNER_<IDENTITY>_INTERMEDIATE` can override it for another issuer. `ADMIN_TOKEN` is a random 256-bit secret. API integration tokens are separate Worker secrets. Local copies are ignored by Git and mode 0600; `.secrets/` is mode 0700. Do not include these files in template archives or deploy assets.

Renew the Pass Type ID certificate before expiry, retaining the same pass type/team. Import the new p12, rerun provisioning to create its mTLS identity, and redeploy the matching signing secret/binding together. Existing pass serials and authentication tokens remain unchanged. Keep the prior mTLS certificate until the new deployment passes the device test, then remove the unused certificate through Cloudflare.

## Live acceptance test

1. Visit `/studio`, unlock with the local `.secrets/admin-token`, and issue a test pass with your own email and a non-access-granting sample key tag. Confirm the email delivery record becomes `sent` and verify receipt of both the `.pkpass` attachment and private link.
2. Add it on a physical iPhone. Confirm poster artwork, original front layout, Code 39 data, membership action, and **Go to Location → selected home gym**. On older iOS, confirm the generic fallback and barcode reader compatibility.
3. Inspect D1 registrations after installation. Update a visible field through the studio or API. Confirm a push delivery is accepted, Wallet requests the changed-serial cursor, fetches the new signed version, and updates the existing card rather than adding a duplicate.
4. Change the home gym and verify the Maps destination changes. Remove the pass and confirm unregister handling. Test a membership API refresh once real upstream credentials are configured.
5. Inspect failed outbox jobs and `wallet-jobs-dlq`; delivery acceptance alone is not proof of receipt. Do not enable public raw invocation URL logs for capability-link routes.

The deployed Workers mTLS connection to `api.push.apple.com` was verified by Apple's response to an invalid token. This establishes production transport/certificate compatibility, but the physical-device test is still required to verify actual Wallet push receipt and background refresh.

`npm run test:admin` exercises write workflows and the UUID fallback using isolated local data and fake delivery providers. It requires Playwright and Chromium; set `PLAYWRIGHT_PACKAGE` to an existing Playwright `package.json` if it is installed elsewhere. `node scripts/browser-check.mjs` checks the live directory, editor, draft preservation, templates, status, and mobile layout without saving passes or sending email. Its optional `--legacy-uuid` flag removes the browser API for a compatibility check; actual UUID generation is tested locally.

`scripts/live-check.mjs --updates` changes only the designated setup-test pass and exercises real Wallet endpoints and APNs invalid-token cleanup. It retains capability URLs only in `.secrets/`. For a stale local DNS cache, `WALLET_TEST_ADDRESS` can be set to the current publicly resolved address; hostname and TLS validation remain enabled.

## Provider references

- [Cloudflare Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/) and [Workers sending API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/).
- [Create a sending subdomain](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/methods/create/) and [required sending DNS records](https://developers.cloudflare.com/api/resources/email_sending/subresources/subdomains/subresources/dns/methods/get/).
- [Workers mTLS bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/mtls/) and [certificate upload API](https://developers.cloudflare.com/api/resources/mtls_certificates/methods/create/).
- [Apple pass update service](https://developer.apple.com/documentation/walletpasses/adding-a-web-service-to-update-passes).
- [Apple Maps unified URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls). Verified home-gym IDs and the supplied share links are recorded in `src/templates/henrys-clubs.ts` and `docs/henrys-reference.json`.
