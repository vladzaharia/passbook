# G: polaris-key as a reference for the wallet redesign

Read-only study of `/Users/vlad/Repos/polaris-key` at `88483cd3ad` (2026-10-31). All paths below
are relative to that repo unless they start with `/`. `W/` = `packages/worker/src/`,
`A/` = `packages/admin/src/`.

## 1. Summary

1. **Email-based licence assignment exists and is mature.** A licence has an optional `email` and an
   optional `account_id`; "assigned, waiting" means email set and no account yet. It joins an
   account automatically **only when that account has verified the address**: when the licence is
   created (or given an email), and when an account verifies a new address. No placeholder accounts
   are created (`W/core/licensing/licenseHolders.ts`, `W/services/identity/accounts/holders.ts`).
2. **Email normalisation is just `trim().toLowerCase()`.** No plus-address stripping, no Unicode
   folding. Strict ASCII validation (`strictEmail`) is applied where mail is sent or sign-in starts,
   but **not** when an admin types a licence email (`W/platform/email.ts`, `W/core/strictEmail.ts`).
3. **The OIDC client is hand-written on `jose`, with no auth library.** It does discovery, PKCE S256,
   state and nonce, RFC 9207 `iss`, gated JWKS and an exact `aud`/`azp` check
   (`W/core/oidc/client.ts`). The console signs in through **Pocket ID at `https://id.plrs.im`**.
   Admin access is decided by the `groups` claim containing `PLATFORM_ADMIN_GROUP` (`admins`), with
   no roles stored in the database.
4. **Magic links exist.** One email carries both a 6-digit code and a magic link, bound to the
   browser that asked for it. A GET of the link consumes nothing, so mail-scanner prefetches cannot
   burn it. Single-use state lives in a Durable Object. Mail goes out through Cloudflare's
   `send_email` binding, and Turnstile protects the send step
   (`W/services/identity/card/emailSignIn.ts`).
5. **Sessions are stateless signed cookies.** Each is an HMAC token in a `__Host-` cookie with a CSRF
   token inside, which the client sends back in a header. Admin: 8 h, `SameSite=Strict`, sign-out
   revocation through a Durable Object mark. Portal: 14 d, `SameSite=Lax`, plus an
   `account_sessions` row in D1 so sessions can be revoked.
6. **Admin UI stack:** React 19, Vite 6, Tailwind v4, `radix-ui`, TanStack Query/Table/Virtual,
   react-hook-form, sonner, cmdk and lucide, with a hand-written hash router. The UI is dark-first,
   with an OS-following theme and a saved override.
7. **The design system `@polaris-key/brand` is reusable.** It is MIT-licensed and published on the
   public feed `https://pkg.plrs.im/npm/polaris-key/` (not npmjs). It ships tokens, Tailwind v4
   theme, fonts and marks. The admin's component library (`A/ui/*`) is **not** packaged; it is
   private to `@polaris-key/admin`.
8. **Direction to note:** polaris-key is moving **end users off Pocket ID** onto its own
   "Polaris Key accounts" (email code, magic link, passkeys), leaving Pocket ID for operators only
   (`docs/RUNBOOK.md` "Moving end users off the platform IdP"). Polaris Key is **not** an OIDC
   provider other web apps can use.

---

## 2. Email-linking semantics, written as a spec wallet can adopt

### 2.1 Data model in polaris-key

| Table / column | Purpose | Source |
| --- | --- | --- |
| `licenses.email TEXT` | The holder's address, **stored trimmed but in the case it was typed** (shown to admins as typed) | `migrations/0001_init.sql:65-83`; write path `W/services/license/admin/licenses.ts:130-139,423-432` |
| `licenses.account_id TEXT NULL` | The owner pointer. NULL means not in an account. Written only through Core (`attachLicenseAccount`, `stmtMoveLicenseAccount`) | `migrations/0068_b_licenses_account_id.sql`; `W/core/accounts/accountSubjects.ts:276-306` |
| `licenses.email_issuer_class TEXT NULL` | Which issuer class (`platform`/`custom`) vouched for the email, recorded when the licence is minted. NULL means an operator typed it. Stops a later product edit from making old rows auto-linkable after the fact | `migrations/0118_license_email_issuer.sql` |
| `idx_licenses_email_lower ON licenses(lower(email))` | Index for the matching query | `migrations/0015_data_integrity.sql:34` |
| `accounts(id, primary_email, primary_email_verified_at, status …)` | The person. **No row exists until a credential is verified** | `migrations/0068_a_accounts.sql` |
| `account_links(account_id, issuer_key, tenant_scope, subject, kind, email, email_verified, …)` with `UNIQUE(issuer_key, tenant_scope, subject)` | Sign-in methods. Email method: `issuer_key='email'`, `subject` = normalised address. OIDC method: `issuer_key` = issuer URL, `subject` = `sub` | same file |
| `license_auto_attach_blocks(product, license_id, account_id, created_at)` PK all three | "Never auto-attach this licence to this account again" | `migrations/0092_license_auto_attach_blocks.sql` |
| `portal_product_settings.auto_link_enabled INTEGER NULL` | NULL means automatic: on for platform-issuer products, off for tenant (`custom`) issuers. 1/0 is an operator override | `migrations/0013_portal_auto_link.sql`; SQL in `W/services/identity/portal/repo.ts:396-427` |
| `portal_audit` / `audit` | Every transition writes one row (`account.license.attach` with `via`, `license.holder.assign`, `account.license.auto_attach_block`, `account.license.relink`, …) | `W/services/identity/portal/repo.ts:509-529` |

There is **no stored "holder state" column.** The state is derived (`W/core/licensing/licenseHolders.ts:60-111`):

- **floating**: `account_id IS NULL AND (email IS NULL OR TRIM(email) = '')`
- **assigned, waiting**: `account_id IS NULL AND email` is not blank
- **assigned, in an account**: `account_id IS NOT NULL`

### 2.2 Which emails count as "verified" for an account

`verifiedAccountEmails(accountId)` (`W/core/accounts/verifiedEmails.ts:11-26`) is the union of:

- `account_links.email` where `email_verified = 1`. This covers email sign-in methods (proved by
  code or magic link) and provider links whose provider vouched for the address.
- `accounts.primary_email` when `primary_email_verified_at IS NOT NULL`.

Its inverse, `accountsVerifyingEmail(email)` (`W/services/identity/accounts/repo.ts:198-226`),
returns the **active** accounts that verified the address, the email-method holder first.

**Provider trust.** `providerVouchesForEmail` (`W/services/identity/providers/vouch.ts:33-44`)
requires `email_verified: true`; Google adds a hosted-domain rule. The newer
`connectionVouchesForEmail` (`vouch.ts:62-77`) for OIDC connections such as Pocket ID is stricter.
It vouches only if:

- the connection is `active` and platform-scoped;
- the token said `email_verified`;
- the raw address is **plain printable ASCII before it is lower-cased** (this defeats lookalikes
  such as the Kelvin sign);
- the domain is one of the connection's **DNS-verified domains**.

The seeded Pocket ID connection `platform-sso` has **no domains**
(`W/services/identity/connections/seed.ts`). On that path, therefore, a Pocket ID email is **not**
treated as verified; the person proves it with an email code first (the "email gate"). The older
`getOrCreateAccountByIdentity` path does trust `email_verified` from Pocket ID
(`W/services/identity/portal/repo.ts:247-283`). `docs/RUNBOOK.md` makes it a precondition that Pocket ID
users cannot change their own email, or that a changed address is not reported as verified.

### 2.3 Normalisation (exact)

- **Matching key:** `normalizeEmail(s) = s.trim().toLowerCase()`. This is the ONE definition
  (`W/platform/email.ts:12-14`).
- **No plus-address stripping, no dot folding, no Unicode NFC/NFKC folding, no IDN conversion.**
  IDN must arrive as punycode.
- **Strict validator:** `strictEmail(raw)` (`W/core/strictEmail.ts`). It accepts a bare ASCII
  addr-spec, ≤254 characters, local part ≤64, with an RFC-style dot-atom and LDH labels. It rejects
  display names, quoting and lists. It is used for sign-in starts (`card/http.ts:150`, `parseEmail`),
  `login_hint`, and the final send (`W/core/notify/emailDelivery.ts:267,298`).
- **Gap:** the admin licence create and PATCH paths do **not** validate format on the server. They
  check only the "representability" of free text (`W/core/console/writeChecks.ts:120`). The admin UI
  uses a loose `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (`A/console/sections/license/components/shared.tsx:482`).
  A malformed address simply never matches anything.
- The comparison is always `lower(l.email) = normalizeEmail(x)`, so the stored value keeps the case
  it was typed in for display.

### 2.4 Assignment operations

| Operation | Who | Effect | Source |
| --- | --- | --- | --- |
| **Create with email** | admin, `POST /manage/api/products/{p}/license/licenses {email, name, …}` | Stores the trimmed email (blank becomes NULL, which means floating). Then `associateLicenseHolder` attaches it in the same request to the account that verified the address, if exactly one is eligible. **The response is identical either way** (built with `account_id: null`), so it cannot be used to test whether an address has an account. Audit `license.create` records the id only, never the email | `W/services/license/admin/licenses.ts:423-500` |
| **Assign** (floating → assigned) | admin, `PATCH …/licenses/{id} {email}` | Allowed only when the licence currently has no email. Audit `license.holder.assign`; then the same association runs | `licenses.ts:578-612,694-711` |
| **Case-only edit** | admin PATCH | Allowed (`A@x` → `a@x`) | `licenses.ts:597-604` |
| **Change to a different email** | admin | PATCH refuses with `400 "use Reassign"`. **Reassign** goes through the relink tool (I-12): step-up re-auth (≤5 min, `prompt=login max_age=0`), a reason, typing the licence name to confirm, notices to the old and new address, 72 h undo | `licenses.ts:590-604`; `W/services/identity/accounts/claim.ts:348-443`; UI `A/console/sections/license/components/LicenseHolderDialogs.tsx` |
| **Clear email** | admin | PATCH refuses. **Make floating** goes through the relink tool (`toAccountId: null`, clears name and email, optionally signs out devices) | `licenses.ts:578-589` |
| **List filter** | admin | `?holder=floating\|assigned\|waiting\|inAccount` | `licenseHolders.ts:86-111` |

Routes: `/manage/api/products/{product}/license/licenses[/{id}]`,
`/manage/api/products/{product}/users/licenses/{licenseId}/relinks`, and
`…/users/relinks/{id}/undo` (`packages/worker/openapi/polaris-key.v3.yaml:15284,15433,16239`).

### 2.5 The two association directions (the core algorithm)

**A. A pass/licence gets an email** (`licenseEmailAssigned`, `W/services/identity/accounts/holders.ts:61-90`):

1. Load the licence. If it has no email, do nothing.
2. `candidates = accountsVerifyingEmail(email)` (active accounts only).
3. Read the licence's auto-attach blocks. **Steps 2 and 3 always run, before any decision**, so
   the response time does not reveal whether an account exists.
4. If the licence already has an `account_id`, or auto-link resolves off, stop.
5. Drop blocked candidates. Choose the account that holds the address as an **email sign-in
   method**. Otherwise, if exactly **one** candidate remains, choose it. Otherwise (ambiguous) the
   licence stays waiting.
6. `attachLicense(via: "email")` does a compare-and-set,
   `UPDATE … SET account_id=? WHERE … AND account_id IS NULL`, then writes an audit row.

**B. An account verifies an email** (`onAccountEmailVerified` → `accountEmailVerified`, `holders.ts:39-48`
→ `attachWaitingLicensesByEmail`, `W/services/identity/portal/repo.ts:568-603`):

1. Re-check that the address really is in `verifiedAccountEmails(account)`. The caller's word is
   not taken as proof.
2. `SELECT … FROM licenses l WHERE lower(l.email)=? AND l.account_id IS NULL AND <auto-link on> AND NOT EXISTS(block for this account)`.
3. Attach each one with a compare-and-set update, and audit `via: "email"`.

This hook fires wherever an address becomes verified: sign-in finish, linking a new method, and an
auto-link through a verified domain (`W/services/identity/accounts/links.ts:161`,
`W/services/identity/connections/autoLink.ts:94`). A full sweep, `syncAccountLicenseLinks`
(`repo.ts:623-653`), still runs on some portal reads and after sign-in (`portal/api.ts:606,782,1618`,
`card/finish.ts:38`).

### 2.6 Claim and detach rules

`evaluateAttach` (`claim.ts:85-109`) is shared by the preview and the claim, so the preview never
promises what the claim then refuses:

- Already owned by this account → `already_yours` (idempotent).
- Owned by another account → `license_owned`. **An owned licence never moves by key or by email.**
- An automatic attach (`email`, `oidc`) that is blocked → `auto_attach_blocked`.
- A claim **by key** of a licence that carries an email → refused with `license_email_bound`
  unless the account verified that email, or the product sets `claim_by_key`.
- Each attach sends a notice to the licence's email if that email is **not** one of the account's
  verified emails (`claim.ts:247-270`).

**Removal ("Remove from my library")** (`claim.ts:276-334`):

1. Write the auto-attach block **before** clearing `account_id`, so no sweep running in between
   can re-attach the licence.
2. Clear the owner with a compare-and-set.
3. Audit `account.license.detach` and `account.license.auto_attach_block`.

The licence **keeps its email**, so it waits for *another* account that verifies the address.
Only an explicit act (claiming by key, or an admin moving it back) lifts the block. Blocks move to
the surviving account on a merge and are deleted when the account or the product is deleted
(`licenseHolders.ts:199-240`).

**Revocation** works the same in every holder state: disable (reversible), delete, or revoke one
key. Disabling sends no email (S-24 §5.6).

### 2.7 Account-side email changes and multiple emails

- An account can have **many verified emails**: several email methods, plus provider emails, plus
  a primary. A waiting licence attaches if **any** of them matches.
- **Adding** a verified email triggers hook B (`links.ts:160-161`).
- **Removing** an email method does **not** detach licences already attached; ownership is sticky,
  and I found no detach path in `W/services/identity/portal/methods.ts`. The account's only email
  cannot be removed while it is the primary (`methods.ts:20-25`). The last sign-in method can
  never be removed.
- **Accounts are never merged because their emails match.** A new identity whose verified email is
  already used by another account becomes a **join offer** and nothing is written. The person must
  prove the other account in the same browser (`W/services/identity/accounts/signIn.ts:1-30`).
  Merges require proof of both accounts.

### 2.8 Privacy rules worth keeping

- No placeholder accounts: an assigned email lives only on the licence row (S-24 D2).
- The admin cannot tell whether an address has an account before association (D4): the create
  response looks the same either way, and lookups take the same time.
- Audit summaries hold ids, never addresses (`licenses.ts:485-487`).
- Spec: `docs/research/2026-09-29-godot-omniplatform/notes/S-24-licence-holders.md` §5–§7.

### 2.9 The same rules for wallet (pass ↔ email ↔ user)

```
passes.holder_email   TEXT NULL     -- trimmed, case as typed; NULL/blank = unassigned
passes.user_id        TEXT NULL     -- owner pointer; written only by compare-and-set updates
users(id, status, primary_email, created_at, …)
user_identities(user_id, issuer, subject, email, email_verified, created_at, last_used_at,
                UNIQUE(issuer, subject))   -- issuer = 'email' | 'https://id.plrs.im'
pass_auto_attach_blocks(pass_id, user_id, created_at, PRIMARY KEY(pass_id, user_id))
CREATE INDEX idx_passes_holder_email_lower ON passes(lower(holder_email));
```

- `normalize(e) = e.trim().toLowerCase()`. Validate with a `strictEmail` equivalent **on the
  server, at write time**. This fixes the gap noted in §2.3.
- `verifiedEmails(user)` = email identities, plus OIDC identities with `email_verified = 1` (and
  ASCII-only before lower-casing), plus the primary email.
- **Hook A** runs on pass create or assign. **Hook B** runs on every successful verification
  (magic-link or code redemption, OIDC callback that vouches).
- Attach only when `user_id IS NULL`, and never across a block. Removal writes a block first.
- Changing a pass's email is an explicit reassign with an audit row; clearing it is an explicit
  "unassign".

---

## 3. Auth implementation details

### 3.1 Libraries

- **`jose` ^6.2** for JWT/JWKS (`createLocalJWKSet`, `jwtVerify`). JWKS is **not** fetched with
  `createRemoteJWKSet`.
- **`@simplewebauthn/server` 13.3.3** for passkeys.
- **No** openid-client, oauth4webapi, arctic, better-auth, lucia, Hono or other HTTP framework. The
  Worker has its own router (`W/router.ts`) and a deny-by-default console dispatcher
  (`W/console/routes.ts`, `W/console/api.ts`). See `packages/worker/package.json`.

### 3.2 OIDC relying party (`W/core/oidc/client.ts`, 651 lines, worth copying almost verbatim)

**Discovery** (`:349-395`):

- fetches `${issuer}/.well-known/openid-configuration`;
- `issuer` must equal the configured issuer exactly;
- the document must list `code` in `response_types_supported`;
- every URL in the document must be on the allowlisted hosts (the issuer's host);
- cached for 1 h in isolate memory.

**Gated fetch** (`:156-230`): https only, no credentials in the URL, default port only, no
private/loopback addresses, `redirect: "manual"` (any 3xx is a failure), 64 KB response cap, 10 s
timeout.

**PKCE and request parameters** (`:413-460`, `W/platform/pkce.ts`):

- PKCE S256 with a 32-byte base64url verifier;
- `state` and `nonce` are 16 random bytes each;
- the authorize URL carries `response_type=code`, `code_challenge_method=S256`, and the scope
  `openid email profile groups`.

**RFC 9207** (`:397-411`): if the issuer advertises `authorization_response_iss_parameter_supported`,
`iss` is required on the callback; whenever `iss` is present it must equal the issuer.

**Token exchange** (`:462-500`): `client_secret_post`, form-encoded.

**ID token** (`:545-619`):

- algorithms RS256, ES256 or EdDSA;
- issuer must match, and `aud` must equal `clientId` exactly (no default);
- a multi-audience token must carry an `azp` equal to the client;
- `iat` no older than 5 minutes (`maxTokenAge`), 300 s clock tolerance;
- required claims `sub`, `exp`, `iat`; `nonce` must match;
- if the token's `kid` is unknown, JWKS is refetched once (at most one refetch per minute).

### 3.3 Console (admin) sign-in flow with Pocket ID (`W/console/auth.ts`)

**`GET /manage/login`** (`:232-298`):

1. Rate limit 20/min per client network, in the `_admin` bucket.
2. Run discovery and `newFlowSecrets()`.
3. Store the flow record `{verifier, nonce, redirectUri, returnTo?, stepUp?, bindingHash}` in the
   single-use Durable Object with a 600 s TTL. The key is `HMAC(state, KEY_HASH_PEPPER)`, so a
   listing of the store reveals no live states.
4. Set the browser-binding cookie `__Host-pkey_admin_flow` (random 32 bytes, 10 min).
5. 302 to the IdP.

`returnTo` is allowlist-validated (`/docs…` or `/manage…`; no `//`, no `.`/`..`, safe characters
only) and stored server-side in the flow record, never echoed back through the client.

**`GET /manage/callback`** (`:301-430`):

1. Rate limit.
2. Check that the binding cookie's hash equals `flow.bindingHash`. This happens **before**
   consuming the flow, so another browser cannot burn it.
3. Atomically consume the flow (one completion only).
4. Redeem the code (§3.2). A token with no `nonce` is refused.
5. Map the claims: `groups` (string array), name (from `name`, or `given_name` + `family_name`, or
   the email), and `auth_time`.
6. `resolvePrincipal` → `can(principal, PLATFORM, "console", "view")`. Failure is a 403:
   "not an administrator".
7. A step-up flow additionally requires `now - auth_time ≤ 300 s`.
8. Issue the session cookie, clear the flow cookie, 302 to the sanitised `returnTo`.
9. Record security events `admin.signin`, `admin.signin.failed` and `admin.signin.refused`.

**Configuration** (`W/platform/platformOidc.ts:36-52`; `docs/DEPLOYMENT.md:130-200`):

- `ADMIN_OIDC_ISSUER=https://id.plrs.im`, `ADMIN_OIDC_CLIENT_ID`, `ADMIN_OIDC_CLIENT_SECRET`.
  When these are unset, the console falls back to `PLATFORM_OIDC_*`.
- **Two Pocket ID clients**: the console (operators) and the platform (customers), so a leaked
  customer secret or a group mistake on that client cannot reach the console.
- Pocket ID client settings: callback `https://key.plrs.im/manage/callback`, scopes
  `openid email profile groups`, PKCE on, and the client restricted to the `admins` group if Pocket
  ID allows it.

### 3.4 Admin vs user: mapping groups to roles

**Console** (`W/core/rbac/principal.ts`, `W/core/rbac/can.ts`):

- The **root rule**: `holdsRoot = !!PLATFORM_ADMIN_GROUP && groups.includes(PLATFORM_ADMIN_GROUP)`
  grants the Superadmin role.
- It is computed per request from the groups carried in the signed session, and **never stored**.
- If `PLATFORM_ADMIN_GROUP` is unset or empty, no one can sign in (fails closed).
- Removing someone from the group takes effect at their next sign-in, or up to 8 h later when the
  session expires. Rotating `ADMIN_SESSION_SECRET` ends every session at once (`docs/RUNBOOK.md`,
  "Who can use the console").
- Four roles are defined (`superadmin`, `platform_admin`, `product_admin`, `console_access`) behind
  one pure predicate, `can(principal, scope, area, level)`. Only root grants exist today.

**Products (end users)**: `oidc.groupRoleMap`, for example
`{"members": {"role": "user", "tier": "standard"}, "admins": {"role": "admin"}}`.

- Only the identity's own keys are looked up (`hasOwnProperty`, so `__proto__` cannot match).
- The highest-ranked mapped tier wins.
- A malformed map grants nothing.

See `W/core/licensing/issue.ts:63-130` and `docs/DEPLOYMENT.md:185-200`. This is the closest match
to the wallet owner's "admins group + users group" model.

### 3.5 Sessions and cookies

**Admin** (`W/core/console/session.ts`):

- Cookie `__Host-pkey_admin` with `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`
  (8 h, a code constant).
- The value is `base64url(JSON) "." base64url(HMAC-SHA256(key, "pkey.admin.v1|" + body))`
  (`W/platform/hmacToken.ts`). The realm tag means a portal token can never verify as an admin
  token.
- Payload: `{sub, name, email, groups, csrf, exp, authAt, stepUpAt?}`.
- The cookie reader **fails closed on duplicate cookies**, defeating cookie shadowing by a sibling
  subdomain.
- Sign-out (`POST /manage/api/logout`, CSRF-checked) writes a per-`sub` "revoked at" mark into the
  single-use Durable Object. Any session minted at or before the mark is refused
  (`W/core/console/sessionRevocation.ts`).

**Portal/account** (`W/services/identity/portal/session.ts`, `accountSessions.ts`):

- Cookie `__Host-pkey_portal`, `SameSite=Lax`, 14 days.
- Same HMAC format with the tag `pkey.portal.v1|` and the secret `PORTAL_SESSION_SECRET`. There is
  no fallback to the admin secret.
- The cookie carries a `sid`. Its peppered hash is the key of an `account_sessions` row in D1
  (revoked/expired/last_seen/user_agent label), which makes "sign out everywhere" possible.
- The flow-binding cookies `__Host-pkey_signin`, `_gate`, `_passkey`, `_link` and `_sso` are
  stripped from every product route (`W/core/accounts/accountCookies.ts`).

### 3.6 CSRF and same-origin checks

- **Admin:** every non-GET request must send `X-PKey-CSRF` equal to `session.csrf`, compared in
  constant time (`W/console/api.ts:307-320`). The SPA reads the token from `GET /manage/api/me`
  (`W/console/handlers/me.ts:65`) and sends it with every write (`A/api.ts:4278-4368`).
  `SameSite=Strict` is the primary defence.
- **Portal:** the header is `X-PKey-Portal-CSRF`. Sign-in JSON endpoints also require
  `Sec-Fetch-Site: same-origin`, or a matching `Origin` header, plus an `application/json` content
  type and a 64 KB cap (`W/core/accounts/browserRequestGuard.ts`).

### 3.7 Magic link and email code (`W/services/identity/card/emailSignIn.ts`, header `:1-55`)

1. **`POST /api/signin/email/start {email, turnstileToken?, returnTo?}`**:
   - parse the address with `strictEmail`;
   - verify Turnstile;
   - check the send limits;
   - open a flow in the single-use DO, bound to the `__Host-pkey_signin` cookie (10 min);
   - send **one email containing both a 6-digit code and a magic link**.

   **The address is never looked up.** Known, unknown, rate-limited and suppressed addresses all get
   the same answer; only "mail unavailable" returns 503. The address stored in the flow record is
   sealed under the platform KEK.
2. **`POST /api/signin/email/verify {code}`** redeems the code in the same browser. The code has 6
   digits, lives 10 minutes and dies after 5 wrong attempts. Ten wrong attempts in an hour lock the
   recipient out of new codes for 15 minutes (`W/core/notify/emailLimits.ts:38-60`).
3. **`GET /magic/verify?token=`** is a landing page that **consumes nothing**, so link prefetchers
   cannot burn the link. Its button POSTs the token back:
   - in the same browser, it completes the sign-in;
   - in another browser, it only marks the flow "confirmed", showing "requested at <time> from
     <place>", and the original browser picks that up by polling. The link never signs in a
     different device.
4. **Resend**: waits 60 s and sends at most `EMAIL_SEND_PER_RECIPIENT_HOUR` (5) emails per flow.

**Limits:** 5 sends per recipient per hour and 20 per day, 10 per IP per hour, a per-network cap,
and 8 starts per IP per minute.

### 3.8 Rate limiting, Turnstile and email sending

- **Rate limiting:** an atomic per-key Durable Object (`RateLimitDO`), sharded. Each bucket has an
  explicit fail-open or fail-closed policy (`W/core/rateLimit.ts`, `W/rateLimitDo.ts`).
- **Single-use artefacts:** `SingleUseDO`, consumed atomically, because KV get-then-delete is racy
  (`W/core/singleUse.ts`).
- **Turnstile** (`W/services/identity/card/turnstile.ts`): only on the email start (the step that
  sends mail). It checks `siteverify` with a 5 s timeout and **fails closed**, and is disabled when
  `TURNSTILE_SECRET_KEY` is unset. The site key is a wrangler var.
- **Email:** Cloudflare Email Service `send_email` binding `EMAIL` with `allowed_sender_addresses`
  (`noreply@plrs.im`, `noreply@auth.plrs.im`). All mail goes through one choke point,
  `deliverEmail` (`W/core/notify/emailDelivery.ts`), which applies:
  - `strictEmail`;
  - an Apple private-relay guard;
  - a hashed suppression list;
  - a per-product daily cap;
  - mapping `E_RECIPIENT_SUPPRESSED` from the provider.

  Templates are plain functions in `W/core/notify/templates.ts`. `render.ts` produces table-layout,
  inline-styled HTML with brand colours, a dark-mode media block and the PNG lockup.

### 3.9 Linking OIDC and magic-link identities

There is one entry point, `signIn(VerifiedIdentity)` (`W/services/identity/accounts/signIn.ts:1-30,156`):

- a known `(issuer_key, tenant_scope, subject)` signs in to its account;
- an unknown identity whose verified email belongs to another account becomes a **join offer**
  and writes nothing;
- otherwise a new account is created.

An email sign-in uses `issuer_key='email'` and `subject = normalizeEmail(addr)`. An OIDC sign-in
uses `issuer_key` = the issuer URL with no trailing slash (`portalIdentityIssuerKey`, `repo.ts:218`).
To link another method later, the person must have re-authenticated within the last 5 minutes.

---

## 4. Admin UI stack, design system and reuse options

### 4.1 `packages/admin` (private, MIT repo)

- **Build:** one Vite 6 build with two entry points: `index.html` (customer portal at `/`) and
  `manage.html` (console at `/manage`). See `packages/admin/vite.config.ts`.
  - Vendor chunks: radix, query, cmdk.
  - CodeMirror is lazy-loaded.
  - Brand favicons, fonts and lockups are emitted from `@polaris-key/brand` at build time.
  - Dev proxy to `wrangler dev` on :8787.
- **CSP:** strict `style-src 'self'`. Three Vite plugins neutralise inline `<style>` injection in
  sonner, style-mod (CodeMirror) and Radix Select. The Worker allows exactly one inline script by
  hash: the pre-paint theme script (`W/core/adminCsp.ts`). Parity tests on both sides keep them in
  sync.
- **Libraries:** React 19.3, Tailwind v4.3 (`@tailwindcss/vite`, CSS-first `@theme`), `radix-ui`
  1.6, `class-variance-authority`, `clsx` and `tailwind-merge` (shadcn-style),
  `@tanstack/react-query` 5, `@tanstack/react-table` 8, `@tanstack/react-virtual` 3,
  `react-hook-form`, `sonner` (toasts), `cmdk` (⌘K palette), `lucide-react`, `diff`.
- **Router:** a hand-written hash router (`A/console/router.tsx`). It handles route tables
  (`nav.ts`, `routes.ts`), real `<a href>` links, query-state hooks, a navigation blocker for
  unsaved changes, and View Transitions that respect reduced motion.
- **Data fetching:** a single `call()`/`send()` transport (`A/api.ts:4278-4400`).
  - Requests use `credentials: "same-origin"` and send the CSRF header on writes.
  - A 401 redirects to `/manage/login`.
  - A stale step-up redirects to `/manage/login?stepUp=1&returnTo=…`.
  - Errors become a typed `ApiError` carrying `{status, code, fields, errors, reason}`.
  - TanStack Query provides keys and mutations (`A/console/data/`).
- **Component library:** `A/ui/*`, about 60 components, including Button, IconButton, Dialog,
  Drawer, ConfirmDialog, DataTable/ScrollTable, Combobox, Select, SegmentedControl, Switch,
  StatusPill, Timeline, Timestamp, CopyButton, OneTimeSecretPanel, SecretInput, CodeEditor,
  JsonViewer, DiffViewer, EmptyState, Skeleton, SaveBar, wizard, form (react-hook-form glue) and
  toast.
- **Shell:** `A/console/shell/*`: AppShell, Sidebar with collapsible sections, TopBar with
  breadcrumbs, a ⌘K CommandPalette, ThemeMenu, UserMenu, EnvironmentBadge, ProductSwitcher.
- **Tests:** Vitest with jsdom, Testing Library and `vitest-axe` (accessibility); Playwright for
  e2e and baselines.

### 4.2 `@polaris-key/brand` (the design system)

**Distribution.** `"license": "MIT"`, not private, listed as `npm.brand` in `.pkey/release.yaml:36`.
It is published only on Polaris Key's own feed:

```ini
@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/
```

The feed is public, with no account or token needed (`packages/docs/src/content/docs/build/install.mdx:13-25`).
The fonts are Rubik and JetBrains Mono under the OFL (`packages/brand/THIRD_PARTY_NOTICES`).

**Exports.**

- CSS:
  - `tokens.css`: generated `--pk-*` variables for surfaces, text, borders, focus, action, status,
    signed (gold), scales, motion, and per-service section accents;
  - `theme.css`: Tailwind v4 `@theme` names such as `bg-surface-raised`, `text-fg-muted`,
    `bg-accent`, `ring-focus`, `border-border`;
  - `fonts.css`, `kit.css`, `marketing.css`.
- JS/TS: `THEME_TOKENS`, `resolveAccent(hex, theme)` (a contrast-checked accent from any colour),
  `deriveAccent`.
- React and SVG marks.
- Assets: lockups, favicons, social cards.

**Theme mechanics** (`packages/brand/css/tokens.css:10-22`, `A/components/theme.tsx`):

- **Dark first.** `:root` is dark. Light applies under `prefers-color-scheme: light`.
  `data-theme="dark|light"` on `<html>` overrides either way, and can re-theme a subtree.
- The preference is saved in `localStorage["pk-admin-theme"]` as `system|dark|light`.
- An inline pre-paint script prevents a flash of the wrong theme.
- Section accents use `data-service="core|license|…"`.

**The look.** Screenshots are in `docs/design/experience/*.png`; I viewed
`05-console-overview-desktop-dark.png`, `06-console-licenses-desktop-dark.png`,
`01-signin-portal-desktop-dark.png` and `02-signin-console-desktop-dark.png`.

- Near-black navy page (`#060912`) with raised cards a step lighter (`#0d111b`) and thin subtle
  borders (`#212633`).
- Rubik type. Bold headings, uppercase small-caps section labels in the sidebar.
- Left sidebar with collapsible service sections and a product switcher card on top. Top bar with
  breadcrumbs, a ⌘K search pill and an avatar.
- One saturated accent per section: violet `#9a5cff` for core, lime `#c6e940` for license, and so
  on. The primary button fills with the accent and uses dark text.
- Table rows with a two-line holder (bold name, muted email), filter chips with counts, and pill
  badges with an icon and a coloured outline.
- The sign-in card is centred on a starfield background with a large rounded panel.
- Note that the console sign-in mockup (email-first, "Next: Pocket ID at id.plrs.im", passkey) is
  a **design** for ST-30. The code that ships today redirects straight to Pocket ID.

**Branding caveat.** The marks are Polaris Key's own: the "Pinned K", and the "Star Cut" for
Delivery. Wallet should use the tokens and fonts but **not** the Polaris Key mark or name.
`docs/design/BRAND.md` (1147 lines) is the governing spec. §3 covers theme mechanics, §5 accents
and §7.6 console density.

### 4.3 `ui-core` and `elements` are not relevant

- `@polaris-key/ui-core` is a headless set of view models for the **licensing SDK UI kits**
  (Activate, SignInModel, …), with no DOM. It is not a general component library.
- `@polaris-key/elements` is private web components for the same kits.

### 4.4 Ways wallet can reuse it

| Option | Effort | Consistency |
| --- | --- | --- |
| **A. Tokens only:** add `.npmrc` routing, `npm i @polaris-key/brand`, `@import` `fonts.css` and `tokens.css` into wallet's existing CSS, and use `var(--pk-…)`. Keep the current vanilla `src/admin/client.ts` | Low | Same palette, type, theme switching and motion |
| **B. Tokens + Tailwind v4 + copied primitives:** Tailwind v4 with `theme.css`; copy the needed `A/ui/*` components and shell pieces (MIT, same owner) into wallet | Medium | Close match to the console's look |
| **C. Full stack match:** React 19 + Vite + Tailwind v4 + radix + TanStack Query + the same shell | High (wallet today is Hono + vanilla TS + `node:test` + npm) | Identical |

Matching gives visual consistency across `*.plrs.im` products, because they share tokens, fonts,
dark-first behaviour and accent logic. Wallet would pick its own accent, for example through
`resolveAccent`, or a `data-service`-style override of `--pk-accent*`.

---

## 5. Cloudflare and tooling patterns

### 5.1 Cloudflare products (`packages/worker/wrangler.toml`)

- Workers with `nodejs_compat` and `compatibility_date = "2026-04-07"`.
- Static assets: `run_worker_first = true` and `html_handling = "none"`; the Worker routes the SPA
  shells itself.
- **D1** `DB`, **KV** `HOT` (a hot cache for key-hash → licence lookups), **R2** `BLOBS`.
- **Durable Objects** (all `new_sqlite_classes`): `RateLimitDO`, `SingleUseDO`, `UpdateHealthDO`.
- **Queues** with dead-letter queues: deltas and hosted assets.
- The **Images** binding, `version_metadata`, and the **Email Service** `send_email` binding.
- **Cron triggers** `17 3 * * *` and `*/15 * * * *`.
- **Observability:** logs persisted, invocation logs off, traces off.
- Custom domains: `key.plrs.im`, `dl.`, `pkg.`, `img.`.
- **Environments** `prod`, `staging`, `dev` and `test`. Bindings are repeated in every
  `[env.X]`, because top-level bindings are not inherited. Same Cloudflare account as wallet
  (`07a2eb0d…`).
- **Secrets** are set with `wrangler secret bulk` per environment; the list is in
  `docs/RUNBOOK.md` "Secrets". Session secrets are separate per realm: `ADMIN_SESSION_SECRET`,
  `PORTAL_SESSION_SECRET` and `KEY_HASH_PEPPER`.

### 5.2 D1 migrations (`packages/worker/migrations/`, 0001–0120)

- Files are named `NNNN_name.sql`. One logical change can be split into letter-suffixed files
  (`0068_a…e`, `0105_a…m`).
- **One `ALTER TABLE … ADD COLUMN` per file** (rule R11-04). SQLite cannot make it idempotent, so a
  replay fails on that statement and strands nothing. Everything else uses `IF NOT EXISTS`.
- **Expand-only**: old Workers keep working after the migration. Columns are dropped later in a
  "contract" migration.
- Each file has a long header comment covering why, owners, rollback and the test that exercises
  it.
- Builders name new files `00XX_…`; the lead assigns the number at merge (AGENTS.md "Hand-off").
- An **index-assertion migration** lists the required indexes and is re-run after every deploy
  (`docs/RUNBOOK.md:49-55`).
- Apply with `npx wrangler d1 migrations apply <db> --env prod --remote`, **before**
  `wrangler deploy`.
- `W/db/owners.ts` (`TABLE_OWNERS`) names an owner for every table, and a test enforces it.

### 5.3 Tests

- **Node lane** (fast, broad): Vitest plus `better-sqlite3`, through a tiny `Db` interface
  (`W/db/types.ts`: `all`, `first`, `run`, `runChanges`, `batch`). It applies every migration in
  filename order (`test/helpers.ts`). About 394 test files.
- **workerd lane** (small, on purpose): `@cloudflare/vitest-pool-workers` 0.19.1. It reads the real
  `wrangler.toml` and `readD1Migrations` (sorted by filename), and covers only behaviour that
  differs in workerd: codegen, WebCrypto Ed25519, D1, KV, DOs, R2 (`vitest.workers.config.ts`).
- **OIDC tests** run without a live IdP, using an injectable `IdTokenVerifier`
  (`W/console/auth.ts:125-134`) and an injectable `OidcFetch` in the client.
- **Architecture tests:** `boundaries.test.ts` (layer imports), `routeCoverage.test.ts` (router vs
  OpenAPI), `tableCrossings.test.ts`, `auditWriter.test.ts` and `adminCspParity`.
- **Deploy:** the GitHub Actions `deploy.yml` deploys only `v*` tags that are ancestors of `main`
  and only once CI is green on that commit.

### 5.4 Monorepo tooling and conventions

- pnpm 10.33 workspaces plus turbo 2 (`turbo.json`: build depends on `^build`).
  `onlyBuiltDependencies` allowlists `better-sqlite3`, `esbuild` and `workerd`.
- Node 22 is pinned (`.nvmrc`, `mise exec node@22 --`), only because of `better-sqlite3`.
- **Prettier only, with default config. No ESLint.** "Lint" is `prettier --check`; architecture
  rules are tests instead.
- TypeScript is strict, with `noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
  `isolatedModules` and `NodeNext` (`tsconfig.base.json`).
- Husky pre-commit runs `pnpm gen --fast --check && pnpm typecheck`.
- Generated files carry a banner and are checked by `pnpm gen --check`.
- **AGENTS.md rules for agents:**
  - work packages under an hour; run scoped tests while building and the full gate once at
    hand-off;
  - reviewers never run the gate, and get one fix round;
  - merge `main` once, right before hand-off;
  - stop background jobs before reporting;
  - poll with short intervals tied to an exit signal.
- **CLAUDE.md** says to set `model` on every subagent, never inherit: Sonnet 5.5 for coding and
  security, Opus 5.5 for judgment. Role agents live in `.claude/agents/`
  (`pkey-implementer`, `pkey-wp-reviewer`, …).
- Code comments are long and explain the reasoning ("why"), citing decision ids.

---

## 6. Recommendations for wallet

### Copy nearly verbatim

1. **`W/core/oidc/client.ts`**: the discovery, gated fetch, PKCE, RFC 9207, `verifyIdToken` and JWKS
   cache. It depends only on `jose`. Drop the `@polaris-key/manifest` `isSafeIssuerUrl` import or
   inline it.
2. **The structure of `W/console/auth.ts`**: login and callback, flow record keyed by the hashed
   `state`, a `__Host-` browser-binding cookie, binding checked before the flow is consumed,
   `returnTo` allowlist, injectable verifier for tests.
3. **`W/platform/hmacToken.ts` and the session cookie rules**:
   - `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict` for admin;
   - CSRF token inside the payload, echoed back in a header;
   - reader that fails closed on duplicate cookies;
   - a realm tag per session type;
   - revocation through a per-`sub` mark.
4. **`normalizeEmail` and `strictEmail`**, plus the ASCII-before-lower-casing rule from
   `connectionVouchesForEmail`.
5. **The holder algorithm in §2.5–§2.6**: derived states, hooks A and B, compare-and-set attach,
   auto-attach blocks, and the "an owned pass never moves by email" rule.
6. **The magic-link protections in §3.7**:
   - a GET of the link consumes nothing;
   - the flow is bound to the browser that started it;
   - the token is stored hashed;
   - the response is the same whatever the address;
   - 10 min TTL;
   - one email carries both the code and the link.
7. **Groups mapped to roles at session-verification time, never stored** (`holdsRoot` pattern).
   Use `WALLET_ADMIN_GROUP` and `WALLET_USER_GROUP`. Either one unset means fail closed for that
   role.

### Adapt

- **Single-use store.** Polaris uses a Durable Object, which may be heavy for wallet. Wallet
  already has D1, so a D1 table with `DELETE … RETURNING`, or `UPDATE … WHERE used_at IS NULL`
  checked by `changes`, gives atomic one-time consumption of flows and magic tokens. Keep the
  token **hashed** in the key.
- **Rate limits.** Without a Durable Object, use Cloudflare's Rate Limiting binding, or D1 counters
  for the low-volume sign-in endpoints. Turnstile is optional on the magic-link start.
- **Issuer trust.** Wallet has one trusted issuer (`https://id.plrs.im`), so it does not need
  `email_issuer_class`, `auto_link_enabled` or tenant scopes.
- **Account linking policy, for the owner to decide.** Polaris's rule is that accounts are never
  merged because emails match (join offer plus proof of both accounts). A simpler wallet rule:
  "a Pocket ID sign-in with `email_verified=true` attaches to the user who owns that verified
  email".

  That rule is only safe if, in Pocket ID, users cannot change their own email without it being
  re-verified. Polaris's runbook lists exactly this as a precondition (`docs/RUNBOOK.md`,
  "Before the owner's go", item 2). Otherwise, follow Polaris: an unknown OIDC subject whose email
  is already taken prompts a magic-link proof of that email before the two are linked.
- **Magic-link users.** They hold only the **user** role; admin requires the OIDC `groups` claim.
- **One Pocket ID client vs two.** Polaris splits console and customer clients. Wallet can use one
  client with the `groups` scope, or two if admins and pass holders should be isolated.
- **UI.** At least option A in §4.4 (brand tokens, fonts, dark-first `data-theme` mechanics, the
  pre-paint script allowed by CSP hash). Option B if the admin is being rebuilt anyway.

### Avoid

- Polaris's process overhead: the corpus and generators, seven-language parity, work-package
  bookkeeping, pairwise subjects, tenant scopes and the erasure fence. None of it is needed for
  wallet.
- Leaving the admin email unvalidated on the server (Polaris's gap).
- KV get-then-delete for one-time tokens (Polaris documents why it is racy: G15).
- `createRemoteJWKSet` or any library that follows redirects to arbitrary hosts.
- Using the Polaris Key marks or name on wallet.

---

## 7. Anything unclear

- **Pocket ID's long-term role.** Polaris Key plans to make Pocket ID operator-only after a sunset
  (`PLATFORM_OIDC_MIGRATION` / `PLATFORM_OIDC_SUNSET`, `docs/RUNBOOK.md:205-290`). The table that
  records the owner's decisions there is still all `pending`. If end users are moving off Pocket
  ID, the owner's request that wallet users sign in with Pocket ID may need confirming. Polaris Key
  does **not** run its own OIDC provider (no `/.well-known/openid-configuration` is served), so
  wallet cannot "sign in with a Polaris Key account" through OIDC today.
- **Whether `email_verified` from id.plrs.im is trusted.** The legacy path trusts it; the newer
  connection path does not, because the seeded connection has no verified domains. The owner has
  not recorded the "Pocket ID `email_verified` precondition confirmed" decision (pending in the
  runbook table).
- **Whether removing an email detaches licences.** I found no code that does it, so ownership looks
  sticky. I did not trace every portal handler.
- **The console sign-in mockups** (email-first, passkey) are design targets (ST-30); the shipped
  console redirects straight to Pocket ID.
- **Pocket ID's `groups` claim format.** It is assumed to be an array of group-name strings
  (`docs/DEPLOYMENT.md:135`). Polaris filters out anything that is not a string and does an exact,
  case-sensitive `includes`.
