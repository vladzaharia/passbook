# Templates and update sources

Templates and source adapters are trusted, version-controlled code. The service accepts only the personalization schema declared by a registered template. It does not expose an asset uploader, certificate uploader, arbitrary pass JSON editor, or arbitrary remote URL fetch endpoint.

## Add a template

1. Add `templates/your-template.pkpasstemplate/` with `pass.json`, icon/logo/artwork files, optional localized `.strings` files, and optional Pass Designer `tooling.json`.
2. Run `npm run assets`. The build indexes PNGs and localization files into `src/generated/your-template-assets.ts` and copies them into the static asset deployment. `tooling.json` is never shipped inside a signed pass.
3. Create a `PassTemplate` module under `src/templates/` and register it in `index.ts`. Import the native JSON and generated asset map. Declare the template ID, integer version, name, signing identity, APNs binding name, and input schema.
4. Map inputs by Wallet field key (`fieldKeys`) or JSON Pointer (`paths`). A `customize(pass, input)` hook handles relationships such as home gym → native Maps action and eligible locations.
5. Add separate PEM secrets `SIGNER_<IDENTITY>_CERTIFICATE` and `SIGNER_<IDENTITY>_PRIVATE_KEY`, plus a matching mTLS binding for APNs. Identity names are uppercased and hyphens become underscores. WWDR G4 is bundled; set `SIGNER_<IDENTITY>_INTERMEDIATE` if the certificate uses a different intermediate. Multiple artwork themes can share one identity/binding. A different Pass Type ID needs its own certificate and binding.
6. Increase `version` whenever art, fixed text, mappings, or behavior changes. Existing passes are immutable until rebuilt; PATCH their personalization with `{}` or run their configured source refresh to regenerate and notify them.

Do not change a deployed pass's serial number, pass type, team, or authentication token to update it. Server-owned identity fields cannot be mapped through input JSON pointers. URLs are validated; member values are escaped in HTML. Asset file names are validated before signing.

The core generator is template-independent. Henry’s' home-club behavior and both themes live in `src/templates/`. The current studio and email presentation use a logo/icon convention, and the studio's illustrated preview is specific to Henry’s; additional brands can add their own preview renderer while using the same schema-driven editor and API.

## Add an API adapter

Implement `UpdateSource` in `src/sources/`, then register it in `src/sources/index.ts`. `refresh` receives a trusted server-side environment, the external record reference, current scalar personalization, and an injectable `fetch`. It returns only the changed or authoritative personalization fields. It can call any API protocol you implement; HTTP JSON is supplied as a convenience adapter.

```ts
const source = httpJsonSource({
  id: 'club-system',
  intervalSeconds: 900,
  request({ env, reference }) {
    return new Request(
      'https://api.example.com/members/' + encodeURIComponent(reference),
      { headers: { Authorization: `Bearer ${env.CLUB_API_TOKEN}` } }
    );
  },
  map(data) {
    // Validate the upstream payload before mapping it to your template's schema.
    const member = parseClubMember(data);
    return { memberName: member.name, membership: member.plan };
  }
});
```

`parseClubMember` represents your own runtime validator. Add custom environment fields and upload secrets with Wrangler. Keep base URLs and authentication in server configuration; do not accept them from pass holders. The HTTP helper enforces HTTPS, refuses redirects, applies a 15-second timeout, and limits response bodies to 256 KiB. Final template validation also runs on every mapped update.

The included `membership-api` adapter calls `{MEMBERSHIP_API_BASE_URL}/members/{encodedReference}` with a bearer token. Its explicit example contract is:

```json
{ "name": "Alex Morgan", "membership": "All-Inclusive Wellness", "active": true, "keyTag": "000123" }
```

It polls every 15 minutes; Cron dispatches due work each minute. `keyTag` is optional and must be a string. This is an example integration contract, not a claim that Henry’s exposes this endpoint. Configure the real membership system's API and mapping before assigning that source to real passes.

Refresh failures preserve the current signed pass and record `SOURCE_REFRESH_FAILED`. Changed values create a new signed version and a transactional push job; identical values produce no push. A webhook can invoke the authenticated `/sync` endpoint for faster refresh. If a provider requires its own webhook signature, implement a narrow verification route that then queues the same sync job.

## Delivery adapters

`src/jobs.ts` separates outbox dispatch from pass generation. `src/email.ts` assembles the Cloudflare Email Sending payload. APNs selects the mTLS binding named by each template's `apnsBinding`. The queue consumer and scheduled handler share the same durable ledger, so temporary Queue or provider failures can be retried without losing a published version.
