> `TenantCustomerPortfolio` is running a newer turn. The output below is from its PREVIOUS run (published 13.4s ago), not the current one. Live progress: `history://TenantCustomerPortfolio`; its next result auto-delivers to its owner.## Verdict

**The intended cross-org portfolio is implemented as a union by stable account owner—not as proof that every pass belongs to one verified human.** Organization source data remains separate, but mailbox-based attachment cannot distinguish individual, family, or shared-staff ownership. Customer aggregation must remain distinct from organization administration.

This is a current-state source audit; no patch-introduced identity findings are asserted.

## Established behavior

- **Global account, multiple verified addresses.** `users`, `user_emails`, and `auth_identities` are global; a verified email belongs to one account (`migrations/0001_platform.sql:19-48`). Primary/secondary addresses are sign-in/contact mechanisms, not separate people. Verification establishes mailbox control; platform administrators can also assert verification.

- **Automatic cross-org attachment.** Issuance calls Hook A, which attaches an unowned pass to the eligible account verifying its holder address (`passes/create.ts:154`; `holders/service.ts:65-88`). Verification calls Hook B, attaching every waiting, unblocked pass matching that address, without an org predicate (`holders/repo.ts:194-209`). This deliberately aggregates passes across issuers.

- **My Passes is owner-authorized.** `/api/v1/me/*` requires a session and derives the account ID from it (`me/routes.ts:43-58`). Listing and individual lookup use `owner_user_id = currentUserId`, not matching email or organization membership (`me/repo.ts:41-49`). Refresh/remove first perform that owned lookup (`me/service.ts:86-124`). Tenant API keys cannot use another account’s portfolio through these routes.

- **Tenant management is a different boundary.** Org-scoped keys are pinned to their org and mode; admin sessions are platform-wide (`passes/http.ts:19-34`; `platform/auth.ts:172-211`). Global user detail deliberately returns linked addresses, identities, sessions, and passes across organizations (`users/service.ts:85-140`; `users/repo.ts:110-127`), behind the global admin guard (`users/routes.ts:27-29`). **That endpoint must not become a tenant-admin customer directory unchanged.**

- **Source records are currently pass-local.** Personal fields reside in each pass’s `personalization`; there is no canonical source-person entity. Integration identity is `(org_id, connection_id, external_ref)`, while `external_id` is merely indexed (`0001_platform.sql:275-282,314,322-323`). Identical upstream IDs or emails across orgs do not merge their stored fields. Pass IDs are global; serial uniqueness is signing-identity-wide (`:265,310`), important when orgs share a signer.

## Lifecycle and established gaps

### Sticky ownership is deliberate, but the UI misstates it

Removing a secondary address deletes its verification row; changing primary changes only account contact data (`me/repo.ts:51-66`). Previously owned passes remain attached. New verification takes only unowned passes.

This is compatible with protecting historical ownership when an email is recycled, but contradicts “Passes sent to … stop showing here” (`src/web/portal/account-emails.tsx:133`). This previously reported **P2 mismatch is source-confirmed, confidence 1.0**. Correct the promise rather than silently changing ownership semantics.

### Remove, unassign, transfer, and revocation are different operations

- Customer removal records a `(pass,user)` attachment block and clears ownership, retaining holder email (`holders/repo.ts:243-259`).
- Unassign clears both email and owner; reassign clears ownership immediately and then attempts attachment to the destination (`holders/service.ts:160-201`; `holders/repo.ts:234-238`).
- A caller with `holders:write` can clear a customer’s removal block and immediately reattach them (`holders/routes.ts:24-28,108-126`; `holders/service.ts:203-222`).

These are established design choices, **not consent revocation or secure transfer**. They do not rotate download/device credentials or remove installed registrations. Public access checks bearer capability and org state; Apple access checks the pass token and org state—not its current account owner (`public/service.ts:33-38`; `apple/service.ts:44-58`). Existing bundle capabilities likewise authorize membership independently of ownership (`bundles/public-service.ts:14-18,50-69`).

Connection updates also preserve an existing owner while changing personal fields; upstream email changes do not transfer an owned pass (`passes/connection-passes.ts:42-69`). Reusing a source subject for another person would therefore require an explicit transition; upstream reuse was not established.

### Current defects requiring isolation safeguards

1. **P2 — Tenant-visible global identity enrichment; confidence 1.0.** Reconfirmed the prior `09-red-auth-tenant.md` finding: tenant-readable pass detail exposes global `users.primary_email` through `ownerEmail` (`passes/routes.ts:43-45,91-99`; `passes/detail.ts:158-175`; `passes/repo.ts:68-75`). **The fix must also cover removed owners:** `blockedUsers` falls back to global primary email when the account has no name (`passes/repo.ts:57-64`). Global owner/block IDs additionally permit cross-tenant account correlation; proper pass-row scoping does not minimize those relationships.

2. **P2 — Attachment proof is not atomic with unlink; confidence 0.98.** Hook A reads verified candidates before updating ownership; Hook B separately checks verification before its update (`holders/service.ts:70-78,253-262`). Neither attachment SQL statement requires the verification row still to exist (`holders/repo.ts:183-209`). Unlink between check and write can attach a waiting pass after verification was removed. Require current verification in the attachment statement; Hook A should likewise enforce its block predicate there. Interleaving is source-established, not runtime-tested.

3. **Known conditional P1 authentication chain remains present; source confidence 1.0, production trigger unknown.** Untrusted OIDC can create an account and persist its identity using an unproven primary email; later mailbox proof resolves that same account and attaches passes (`auth/oidc-sign-in.ts:76-115`; `auth/service.ts:132-143`). Whether an eligible production IdP user can claim another person’s address remains unverified. Unproven claims must not anchor canonical account ownership.

4. **Known P2 lifecycle bypass remains present; confidence 1.0.** Holder bundles select owned active passes without an org-active predicate and package their objects directly (`me/repo.ts:79-95`; `me/service.ts:250-265`), unlike public downloads. Reassignment also does not invalidate queued recipient intent: delivery reloads current capabilities/content while retaining the queued recipient (`delivery/service.ts:119-134`; `delivery/email.ts:38-45,71-75,122-143`). These cross-reference the existing audits, not additional duplicate findings.

## Recommended relationship model

1. **Global account:** retain stable authentication identity and exclusively verified aliases. Keep unproven profile claims outside canonical email ownership. Mailbox proof must not be described as unique-human proof.
2. **Tenant-local subject/source record:** model `(org, source namespace, upstream subject)` separately from account and pass. Never merge records by email, name, or coincident external ID. A subject’s contact address is not its account owner.
3. **Explicit pass ownership:** retain a stable account-to-pass ownership relationship with claim provenance and assignment version. My Passes remains the union of that account’s ownership links across issuers.
4. **Separate delegation:** family/guardian/staff access needs explicit, revocable, pass-scoped grants—not a shared email interpreted as one person. Distinguish “Owned” from “Shared with me.”
5. **Separate tenant administration:** org membership authorizes only tenant resources. It must not authorize editing global aliases, disabling a global customer, or viewing their other issuers.
6. **Minimized projections:** tenant responses expose tenant-local customer references/contact data, not global aliases, owner IDs, or account names. Holder responses expose published issuer/pass information, not internal configuration labels. Current My Passes includes raw template/org names (`me/service.ts:47-54`); their intended public classification needs an explicit decision.

## Migration and acceptance

Backfill existing ownership as **legacy attachment**, without recomputing owners from current email. Preserve source namespaces, removal blocks, and signer-wide serial uniqueness. Inventory primary/verified-address collisions; do not entrench unproven email claims.

| Scenario | Required result |
|---|---|
| One account, passes from A/B; stranger’s pass C | Portfolio contains A/B only; foreign detail/refresh/remove returns 404. |
| A’s tenant credentials | Cannot obtain B/C, global aliases, cross-org pass counts, or hidden labels. |
| Same email/source ID across orgs | Separate source records; only explicit ownership links aggregate passes. |
| Secondary unlink/reuse | Existing ownership follows the documented sticky policy; no post-unlink attachment race. |
| Family/shared staff mailbox | No implied unique human; sharing requires explicit scope and revocation. |
| Customer removal | No automatic reappearance; any issuer override is explicitly governed. |
| Transfer/revocation | Defined consent; old capabilities, queued mail, bundle access, and scan credentials cannot receive the new holder’s future data. |
| Org suspension | Public and holder-bundle delivery agree; unrelated issuers remain available. |

**Owner/legal unknowns:** whether shared accounts are permitted, ownership versus beneficiary authority, guardian rights, transfer consent, retention, and whether “remove” means hide or revoke. Cached/installed copies cannot be assumed erased.

No edits, tests, builds, formatting, production access, or secret reads were performed. Acceptance cases above are proposed, not exercised.
