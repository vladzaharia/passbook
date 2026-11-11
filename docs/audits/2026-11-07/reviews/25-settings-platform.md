# Settings audit 1 — policy controls and Worker enforcement

**Scope:** Global/admin settings, organization branding/support/defaults, signing identities, template ownership/version controls, connection lifecycle/configuration, and pass-email delivery. Read-only baseline audit; the working diff contains Android changes, so findings below are **not attributed as patch regressions**. All findings are **confirmed-source**, not runtime verification.

Paths are relative to `/Users/vlad/Repos/wallet`.

## Current controls and enforcement

- **Global settings have no Basic/Advanced split.** Nine fields appear under Sign-in, Email, and Passes and retention (`src/web/admin/settings/fields.ts:27-113`). Defaults are trust-email off, magic links on, sender “PassBook,” refresh coalescing 30 seconds, three historical pass versions plus current, audit 365 days, events 90 days, sandbox 30 days, and three notifying updates per rolling 24 hours. Scan retention 396 days, undo 10 minutes, and lookup allowance 200/hour exist in the API but lack controls here (`src/shared/contracts/settings.ts:26-46`).
- **Persistence/enforcement:** Admin forms PUT changed values; the service validates registered keys, stores scoped JSON, supports null resets, audits changes, and clears its five-second isolate cache (`settings/queries.ts:20-27`; `worker/modules/settings/service.ts:101-147`; `repo.ts:18-34`). Auth, email, notification-budget, and retention consumers read these getters. Retention handlers are actually registered and dispatched (`worker/jobs/cron.ts:36-79`).
- **Organizations/identities:** Details, pass branding, pass email, and support are separate sections. Branding/default identity live on the org row; support/buddy use `org:<id>` settings. Identity selection affects **new passes**, not migration of issued passes (`worker/modules/passes/create.ts:78-99`; `identities/db-resolver.ts:104-115`).
- **Templates:** Ownership, active versions, manifest and input-schema controls govern immutable template versions. Org branding overrides template presentation; per-pass image overrides take precedence. Active-version changes enter automatic reissue (`passes/builder.ts:178-223`; `passes/stale-reissue.ts:47-70`).
- **Connections/delivery:** The wizard progressively hides advanced connector fields until Configuration (`web/admin/connections/config-schema.ts:101-117`). Auto-create and auto-email default off; missing records default to flag. Runtime consumes lifecycle policy and connector-default limits (`worker/modules/connections/service.ts:140-149`; `runtime.ts:90-94`; `records.ts:129-183`). Recipient, attachment, send-on-create and notify-on-edit are per-action controls—not global delivery preferences.

## Strongest findings

### 1. P1 — Preserve recipient and attachment intent when retrying email

`src/web/admin/passes/detail/delivery-tab.tsx:148-151` retries failed email with only a new idempotency key. The original Send action permits another recipient and attachments (`:75-80`), but omitted values become the **current holder email** and `attach:false` (`src/worker/modules/passes/service.ts:227-232`). Retry can therefore send somewhere other than the originally intended address and change delivery format.

**Fix:** Retry through the original outbox intent, or require explicit review of recipient/attachment before creating a replacement send.  
**Acceptance:** Fail an attached send to an alternate address; Retry must not silently send an unattached message to the holder. Escalated immediately to Main.

### 2. P2 — Restrict global-default promotion to global identities

Promoting any identity clears the previous default globally (`src/worker/modules/identities/repo.ts:193-203`). Org-owned identities are accepted, but the resolver refuses that fallback for unrelated orgs and returns Platform instead (`db-resolver.ts:112-115`).

**Impact:** Promoting Org A’s identity silently displaces an intentionally configured global fallback for Org B. Tenant isolation remains enforced; this is not cross-tenant signing.

**Fix/acceptance:** Reserve `isDefault` for global identities; use `org.defaultIdentityId` for tenant defaults. Changing A’s default must leave B’s fallback unchanged.

### 3. P2 — Allow restoring Platform as the global default

`src/web/admin/identities/identity-cards.tsx:145-151` disables both every environment identity and the current default. After selecting an uploaded global identity, the console cannot select Platform again. Certificate upserts do not restore its default flag (`src/worker/modules/identities/repo.ts:23-26`).

**Fix/acceptance:** Permit selecting Platform when it is not current, while retaining deployment-managed APNs restrictions. Switch to an uploaded default and restore Platform entirely through the console.

### 4. P2 — Persist explicit connection lifecycle resets

Blank lifecycle fields are omitted from updates (`src/web/admin/connections/lifecycle-fields.tsx:56-65`). Mapping’s **None** template selection is likewise omitted (`detail-tabs.tsx:72-81`). The update contract does not accept null resets for interval, holder-email pointer or default template (`src/shared/contracts/connections.ts:154-163`).

**Impact:** “Blank uses the connector default” does not work for a saved interval; cleared pointers/templates return after saving.

**Fix/acceptance:** Support explicit null resets. Clear a custom interval and observe connector-default scheduling; with auto-create off, clear template/pointer and observe persisted nulls. Requests/minute and concurrency already implement this correctly.

### 5. P2 — Check connection dependencies before reassigning templates

Template reassignment checks existing passes, but not referencing connections (`src/worker/modules/templates/org-assignment.ts:18-26`; `repo.ts:143-147`). A connection retains its default template, then auto-create routes that ID into pass creation (`connections/records.ts:172-180`), where the changed ownership is rejected (`passes/builder.ts:97-103`).

**Fix/acceptance:** Reject or migrate moves that invalidate connection defaults. An Org A auto-create connection with no issued passes must not be stranded by moving its template to B.

### 6. P2 — Preview effective support contacts

The email preview resolves only org settings/legacy branding (`src/worker/modules/orgs/email-preview.ts:42-48`). Actual email delivery falls back to platform support (`delivery/email.ts:144-148`).

**Fix/acceptance:** Share support resolution. With platform support configured and no org override, preview and delivered email must show the same contact.

### 7. P2 — Filter signing-identity choices by organization

The org picker includes every returned identity (`src/web/admin/orgs/org-form.tsx:139-145`; `identities/queries.ts:34-40`), while server validation rejects another org’s identity (`src/worker/modules/orgs/service.ts:55-62`).

**Fix/acceptance:** Offer global and same-org identities only. Server rejection is an effective counter-control; no cross-tenant signing was established.

## Product recommendations—not confirmed bugs

- Add an **Advanced Scanning/Retention** section for the three implemented API-only policies. Keep NFC unavailable until its real implementation/approval gates exist; its mounted route is presently empty (`src/worker/modules/nfc/routes.ts:1-4`).
- Show effective value, inherited/default source, reset action, last editor and applicability timing. These metadata already exist (`settings/service.ts:89-101`). Clarify that refresh is **per pass**, not the UI’s “per user,” and version retention means **historical versions plus current**.
- Resolve the duplicate accent policy: `branding.accent` remains accepted in settings, while the active form writes `org.branding.accent`; no consumer of the settings key was found.
- Explain that support changes affect new builds immediately but do not schedule existing Wallet-package rebuilds. Legacy branding contacts can also reappear after resetting overrides.

## Strengths and limitations

Admin policy routes require admin sessions and CSRF; template machine reads remain scoped. Trust-email still requires the provider’s verified-email claim (`auth/oidc-sign-in.ts:69-71`). Test email is captured before live provider sending (`delivery/email.ts:87-99`). Preserve these invariants rather than adding disable switches.

No edits, builds, tests, production calls, secret reads or hardware checks were performed. Acceptance scenarios above are proposed checks; deployed configuration and legacy-data prevalence remain unverified.
