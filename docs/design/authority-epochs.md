# Authority epochs and grant rows

Replaces the column-equality fences (audit item 1.4, W3-01, W3-02). Owner decision: trigger-maintained epochs plus one authority grant row per batch.

- **Wallet providers:** they ship dark this release and keep their current fences (see "Provider track" in section 7).
- **Revision 2:** answers the critique in `.wrangler/agent-logs/authority-critique.md` (B1, M1-M7, the minors and the missing items).

## 0. Rules

1. **Authority is re-checked, staleness is compared.**
   - Authority ("may this principal act on this scope now") is evaluated against current rows inside the write transaction.
   - Staleness ("is the row I derived this write from unchanged") is one epoch comparison, used only by writes derived from a read.
2. **Immutable inputs are checked once, in JS.** These rows cannot change under a request:
   - membership roles (`0029`)
   - API key org, mode and scopes (`0039`)
   - session identity, CSRF secret, lifetime, roles and amr (`0047`, amended)
   - `credential_ref_keyset` (`0042:491-494`)
   - `template_releases` and `template_versions`

   Immutability needs both an update guard and a REPLACE guard. Section 1.3 adds the missing REPLACE guards, a REPLACE ban and tests. Without them this rule does not hold.
3. **Epochs are owned by triggers.**
   - They start at 1 and strictly increase. One statement may move an epoch more than once, so tests assert "increased", never "+1".
   - App code never writes them.
   - Only the listed columns move them; volatile columns never do.
4. **Deferred work never re-checks the session that started it.**
   - One-shot work (issuance email, a scheduled broadcast, an import) checks:
     - the durable principal;
     - the org `access_revision` captured when the work was queued (owner answer 3);
     - target lineage.
   - Perpetual work (connection syncs, crons) is standing, not queued, and checks `orgs.status = 'active'` directly. A suspend followed by a reactivate pauses perpetual work; it does not kill it (owner answer 9).
   - Disabling a user is revocation: it stops that user's queued work, and it stays cancelled if the user is re-enabled (owner answers 3 and 9). The disable batch cancels the work; the output check does not rely on the user being active again.
5. **Writes go through a typed grant (§1.2).** A refusal aborts the batch with a classified reason. Never a silent `'0'`, a no-op, `changes()` chaining, NOT NULL tricks or `json_extract('[]',...)` aborts.
6. **Reads never write.** Reads use the read-only `authorityPredicate(principal)` (§1.4), never a grant.

## 1. The model

### 1.1 Epochs

Each column of an epoch'd table falls in exactly one class:
- a bump set (one per epoch);
- **volatile:** changes never move an epoch;
- **fixed:** immutable after insert, guarded by a trigger.

The WP0 classification test reads `PRAGMA table_info` and requires each column in exactly one class. With two epochs on one table, the two bump sets must be disjoint and every column must sit in one bump set, volatile or fixed.

| Epoch | Bump set | Volatile | Fixed | On mismatch |
| --- | --- | --- | --- | --- |
| `orgs.access_revision` (amend `0029`) | `status` | | `id`, `created_at` | 403 `ORG_ACCESS_CHANGED` |
| `orgs.config_revision` (`0052`) | `name`, `slug`, `branding`, `default_identity_id`; settings rows with scope `'org:'\|\|id` (insert, update, delete; a row moved to another scope or key bumps both orgs) | `updated_at`, `branding_dirty_at` | | 409 `SETTINGS_CHANGED` (edit CAS only) |
| `passes.row_version` (`0052`) | everything not volatile or fixed. `scan_code`, `barcode_hash` and `lookup_hash` bump only when `OLD.x IS NOT NULL` (minor 5) | `next_sync_at`, `last_synced_at`, `sync_error_code`, `sync_failures`, `refresh_requested_at`, `last_refreshed_at`, `modified_collision`, `pending_cause`, `pending_actor_type`, `pending_actor_id`, `pending_pass_json`, `pending_source`, `object_sha256`, `object_size`, `content_hash`, `download_token_rotated_at` | `id`, `created_at`, `created_by` | 409 `PASS_CHANGED` (derived writes) |
| `passes.credential_generation`, `lifecycle_generation`, `link_generation` | unchanged (`0030`, `0042`) | | | `authority_denied:lineage` |
| `scanners.credential_epoch` (`0052`) | `token_hash`, `token_prefix`, `csrf_secret`, `revoked_at`, `expires_at`, `org_id`, `mode`, `kind`, `pair_code_hash`, `paired_at` | | `id`, `created_at`, `created_by` | 401 `SCANNER_REPAIR`, the only refusal that unpairs |
| `scanners.config_epoch` (`0052`) | `device_role`, `event_id`, `settings`, `time_zone`; changes to `scanning_devices` other than `capabilities` and `reported_at` (a re-keyed `scanner_id` bumps both scanners) | `name`, `last_seen_at`, `last_ip_prefix`, `paired_label`, `pair_expires_at`, `pair_created_by`, `staff_id`, `staff_since`, `staff_seen_at`, `updated_at` | | 409 `SCAN_CONFIG_CHANGED` |
| `scan_staff.auth_epoch` (`0052`) | `role`, `pin_hash`, `pin_set_at`, `disabled_at`, `org_id` | `name`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_STAFF_CHANGED` |
| `scan_events.config_epoch` (`0052`) | `match_input`, `match_values`, `opens_at`, `closes_at`, `time_zone`, `capacity`, `reentry`, `archived_at`, `org_id`, `mode`; insert, update (both events) and delete of `scan_event_templates` | `name`, `note`, `expected`, `expected_at`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_CONFIG_CHANGED` |
| `scanning_sessions.config_epoch` (`0052`) | `status`, `accepts`, `settings`, `time_zone`, `org_id`, `mode` | `name`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_CONFIG_CHANGED` |
| `connections.generation`, made trigger-owned (`0052`). This is W3-01's `authority_epoch`. | `enabled`, `mode`, `org_id`, `connector_type`, `connector_version`, `config`, `credential_id`, `webhook_credential_id`, `mapping`, `default_template_id`, `holder_email_field`, `auto_create`, `auto_email`, `on_missing` | all other columns | `id`, `created_at` | `STALE_GENERATION` |
| `template_release_heads (template_id, org_scope TEXT NOT NULL, mode, provider) -> release_id, generation` (`0052`). `org_scope` is `''` for platform. | upserted after insert on `template_releases`, including the `legacy` source added by the cutover amendment of `0031`/`0038` | | | 409 `TEMPLATE_RELEASE_CHANGED` (create and publish only) |

**Head lookup precedence:** the org head first, then the platform head (`org_scope = ''`), and the platform head only for `origin = 'baked'` templates.

**Rows checked by value, with no epoch:**
- **Sessions:** `revoked_at IS NULL AND expires_at > now AND idle_expires_at > now`.
- **Memberships:** `id = ? AND revoked_at IS NULL`.
- **API keys:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`.
- **Users:** `status = 'active'`.
- **Templates:** `status = 'active' AND (org_id = g.org_id OR org_id IS NULL)`.

**`updated_at` columns become timestamps.** `orgs`, `templates`, `scanners`, `scan_staff` and `scan_events` keep `updated_at` only as a timestamp. A `check:rules` assertion (WP8) forbids `updated_at\s*=\s*\?` in any non-provider SQL.

**`scanning_config_revisions` (`0024`, in production, read by 10 scan files):**
- WP9 stops writing and reading it; `config_epoch` replaces it.
- The table is dropped by a migration one release later, after a release with no readers. It cannot be amended, because it is in production.

**Trigger shape.** The passes bump set has about 45 columns. To bound expression depth, it is split into three triggers by column group, each with 16 or fewer `IS NOT` terms. WP0's spike runs `EXPLAIN` on them.

```sql
ALTER TABLE passes ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER passes_row_version_a AFTER UPDATE OF <group a> ON passes
WHEN NEW.row_version = OLD.row_version AND (NEW.c1 IS NOT OLD.c1 OR ...)
BEGIN UPDATE passes SET row_version = row_version + 1 WHERE rowid = NEW.rowid; END;
-- _b and _c are the same shape for the other groups
CREATE TRIGGER passes_row_version_monotonic BEFORE UPDATE OF row_version ON passes
WHEN NEW.row_version < OLD.row_version BEGIN SELECT RAISE(ABORT, 'epoch_monotonic'); END;
```

- Several triggers, and `pass_published` re-firing, can bump one publish more than once. That is allowed (Rule 3).
- **Loop safety:** the inner UPDATE touches only the epoch, so the triggers cannot loop whatever `recursive_triggers` is set to. WP0 records D1's actual setting.
- **RETURNING:** returns the epoch from before the AFTER triggers ran. Read the new value with a SELECT later in the same batch.

### 1.2 The grant

```sql
CREATE TABLE authority_grants (
  id TEXT PRIMARY KEY,          -- minted by grant(); one batch only
  scope TEXT NOT NULL CHECK (scope IN ('org', 'org_mode', 'platform')),
  org_id TEXT,
  mode TEXT,
  principal TEXT NOT NULL,      -- 'membership:<id>' | 'api_key:<id>' | 'scanner:<id>' | 'platform:<user_id>' | 'system:<job>'
  purpose TEXT NOT NULL,        -- '<scope>.<area>.<action>', e.g. 'org_mode.pass.publish'
  target_id TEXT,
  denied TEXT,
  created_at INTEGER NOT NULL,
  leak_guard TEXT NOT NULL REFERENCES authority_grant_leaks(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (leak_guard = id),
  CHECK ((scope = 'platform' AND org_id IS NULL AND mode IS NULL)
      OR (scope = 'org' AND org_id IS NOT NULL AND mode IS NULL)
      OR (scope = 'org_mode' AND org_id IS NOT NULL AND mode IN ('live', 'test'))),
  CHECK (purpose GLOB scope || '.*'),
  CHECK (purpose NOT GLOB '*.connection.*' OR IFNULL(mode, '') = 'live'),
  CHECK (principal NOT GLOB 'system:*' OR purpose GLOB '*.job.*')
);
CREATE TRIGGER authority_grants_deny BEFORE INSERT ON authority_grants WHEN NEW.denied IS NOT NULL
BEGIN SELECT CASE NEW.denied
  WHEN 'org' THEN RAISE(ABORT,'authority_denied:org') WHEN 'actor' THEN RAISE(ABORT,'authority_denied:actor')
  WHEN 'config' THEN RAISE(ABORT,'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT,'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT,'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT,'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT,'authority_denied:retention') ELSE RAISE(ABORT,'authority_denied:other') END; END;
CREATE TRIGGER authority_grants_immutable BEFORE UPDATE ON authority_grants
BEGIN SELECT RAISE(ABORT,'authority grant is immutable'); END;
```

**Scope by purpose:**
- `org_mode`: pass, scan, delivery, connection and bundle writes.
- `org`: settings, org profile, memberships, invitations, org-bound API keys, template authoring and release approval.
- `platform`: org create, status and delete; template reassignment between orgs; null-org API keys; platform settings.
- A `platform` grant's CTEs check every org the batch touches (for example, both orgs in a reassignment).

**Invariant (corrected).**
- **Org principals:** for memberships, org-bound keys and scanners, the grant's org and mode come from the principal row joined in the check.
- **Platform principals:** for admin sessions, null-org keys and `system:` jobs, the grant's org comes from the target row, and the check requires that org to be active.
- In both cases, every statement takes org and mode from the grant row, never from the request.

**Typed statements (M3).** `platform/authority.ts` is the only module that may build a guarded write:

```ts
const g = grant(ctx, { purpose: 'org_mode.pass.publish', principal, checks: [orgAccess(...), member(...), passRow(id, rowVersion)] });
g.update('passes', { set: {...}, where: { id }, require: 'one', returning: ['id'] });
g.insertSelect('scans', columns, values);                 // org_id and mode come from the grant row
g.upsert('settings', ['key', 'value', 'updated_at'], values, { update: ['value', 'updated_at'] });
g.joined('scan_event_templates', { where: {...}, delete: true });        // a child reached through a declared edge
g.insertJoined('bundle_passes', { parents: { bundle_id, pass_id }, columns: ['position'], values: [0] });
const results = await g.commit();                         // one batch: [grant insert, ...statements, grant delete]
```

- **Principals.** A membership is `via: 'session'` (a synchronous request: `sessionIdHash` is required and must be live) or `via: 'deferred'` (queued work: the captured `orgAccessRevision` is required, no session is checked, Rule 4). There is no third form. A `platform` or `system` principal that names an org (`orgId`) acts on it only while the org is active.
- **No raw statements leak.** Statements are opaque values that only that grant can commit. They are not `D1PreparedStatement`s until `commit()` runs, so they cannot run outside their batch. `Grant.prepare` is module-private; `prepareGrantForTest` exists for tests, and the lint rejects it elsewhere.
- **Cross-grant mixing throws** `GRANT_FOREIGN_STATEMENT`.
- **One grant per batch.**
  - Choose one. Several grants may share a batch (`grantedBatch`) only when their `codes` are identical, else `GRANT_BATCH_MIXED`: a refusal is translated with the codes of the grants together, not of the one that failed.
  - They run in order: grant B's checks see grant A's writes, because B's insert comes after A's statements.
- **The builder owns the tenant and the epochs.**
  - **Owned columns** come from `TableScope.org`: `org_id`, `scope` (settings) and `id` (orgs), plus the mode column for an `org_mode` grant. A non-platform write cannot name them in `set`, `inc`, `where`, `columns`, an upsert `update`, or a check's conditions (`GRANT_SCOPE_OVERRIDE`).
  - **Epoch columns** are derived per table from `EPOCH_TABLES` and cannot be set, incremented or inserted. A table whose bump trigger is still pending keeps its app-written epoch (`connections.generation` until WP4).
  - Orgs: `where` may be empty (the grant pins the row) and an org grant cannot create one.
- **Org-less children.** `GUARDED_TABLES` declares each child's foreign-key `edges` (`scan_event_templates.event_id -> scan_events.id`; `bundle_passes` has two). `joined` (update or delete) goes through one edge (`via`, default the first) and the parent supplies the tenant; `insertJoined` selects every parent key from the parent rows, which must all be in the tenant, so a cross-tenant link inserts nothing. A parent key cannot be set, so a child cannot be re-parented. `joined` on a table with its own org column is `GRANT_NO_EDGE`. A test checks every edge against `PRAGMA foreign_key_list`.
- **Platform tables.** `users` (`status`) and `sessions` (`revoked_at`) are written only by a `platform` grant, only those columns, and are never deleted through a grant.
- **Upsert.** The conflict target is fixed per table in `GUARDED_TABLES` (settings: `(scope, key)`); the caller lists the columns to update from `excluded`, never the target, tenant or epoch columns.
- **Expressions.** Values in `set` and `where` are literals or one of `maxNow(now)` (`MAX(col + 1, ?)`), `jsonSet(path, value)`, `coalesceTo(value)`, and in `where` `inList`, `gt`, `lt`, `isNotNull`. Fixed text, bound values; the JSON path is validated. Numbers bind as REAL, so `jsonSet` of a number stores `2.0`.
- **Counting rows.** `require: 'one'` on `update`, `delete` and `joined` adds a lineage check to the grant (exactly one matching row in the tenant, or `authority_denied:lineage`). It sees the state before the batch's writes, so it cannot require a row an earlier statement of the same batch creates. `returning: [...]` returns the changed rows; count them there, never from `meta.changes`.
- **Checks.** `rowIs`, `passRow`, `epochIs` and `exactlyOne` are tenant-scoped through the actor row. `releaseHead(templateId, mode, provider, releaseId)` holds when the release is the newest generation for the org, else (for a `baked` template only) for the platform; under `org_mode` the mode must be the grant's. `rawCheck` is read-only SQL that may not mention `org_id`, `mode` or `scope` (use `a.org_id` and `a.mode` for the actor).
- **Reads.** `tenantFilter(alias, table, scope)` emits the org (and mode) predicate against `actor_ok`; use it in every read that joins `authorityPredicate`.
- **No post-batch hooks.** Hooks such as `w.commit?.()` (`passes/repo-write-publish.ts:139`) must return grant statements for the same batch.
- **`system:` grants** come only from `jobGrant(ctx)`, and the purpose must contain `.job.` (`GRANT_BAD_PURPOSE`; the CHECK is the second net). `ctx` must be built by `createJobContext(env, kind)` for queue, cron or workflow; it carries a branded `JobAuthority` whose token is private to `job-authority.ts`. `createDetachedContext(env)` (stores, the scan hub, the template registry) has no brand, and so does a route's `ServiceContext`. `check:rules` fails any importer of `job-authority.ts` other than `service-context.ts` and `authority.ts`, and any `createJobContext` outside `jobs/` and `workflows/`.
- **`check:rules` (WP0 adds; WP8 makes blocking):**
  - no INSERT, UPDATE or DELETE on a guarded table (Appendix B) through `stmt`, `run`, `batch` or `db.prepare` outside `platform/authority.ts`;
  - no `OR REPLACE` / `REPLACE INTO` outside the explicit allowlist in §1.3 (it names `push_results` at `delivery/repo-devices.ts:142`);
  - no `updated_at = ?`.
  - The allowlist covers wallet providers, migrations helpers and test fixtures.

**Deny precedence:** org, then actor, then config, then lineage, release and retention, then stale.

**Why no usable stale grant can exist:**
1. A D1 batch is one transaction on a single-writer database. No other write runs between statement 1 and the last statement, so the check holds for the whole batch.
2. The grant is inserted and deleted in the same transaction, so no other transaction ever sees it. A crash, a thrown error or a lost connection rolls back the grant together with every write.
3. A failed check aborts at the insert, which rolls back the whole batch. There is no path where the grant is missing and later statements no-op into a half-commit.
4. If a builder bug ever kept a row, its id is a 128-bit token that no later code path sends again (`grant()` mints the id per call).
   - Detection: a global worker-test `afterEach` asserts the table is empty, and a daily sweep deletes leftover rows and logs `AUTHORITY_GRANT_LEAK` at `error`.
   - Hard stop: a deferred foreign key to an always-empty sentinel table makes such a batch fail at commit. WP0's spike decides whether D1 enforces deferred FKs at batch commit: if it does, the sentinel FK is mandatory; otherwise nothing load-bearing depends on it.
5. Captured epochs are read on the primary. If D1 read replication is ever enabled, capture reads must use the session bookmark. A replica read is never a safety hole (the grant runs on the primary); it only produces spurious `stale` refusals.

**Lost response (minor 14).**
- Derived writes accept `Idempotency-Key`.
- Without a key, a `stale` refusal re-reads the row. If the row already equals the requested post-state, the response is 200, not 409.

**`/api/v1` (minor 10).**
- `If-Match: <version>` with 412 stays: the client-visible CAS is `passes.version`.
- `row_version` is captured by the server during the same request, never sent by clients.

### 1.2.1 Request-context deferred principals

`via: 'deferred'` is built in a queue, cron or workflow context. A request context may build one only with `allowRequestContext: true`, which is reviewed per site. Each site pins `userAccessRevision` and `orgAccessRevision` captured when the work was captured (a missing user revision is `0`, which never matches), checks no session, and is refused with 403 when the membership is revoked or either revision moved.

| Site | Verdict | Why |
| --- | --- | --- |
| `modules/templates/repo-grants.ts` (import persist) | Removed | The workflow runs on `createJobContext`; the flag was only a test convenience. The import fixture now uses a job context. |
| `modules/sandbox/repo-forward.ts` `finishForward` | Kept | The request has already sent the mail; the outcome must be recorded in that request even if the owner signed out meanwhile. A job would leave the reservation `sending` until its lease expires. The user revision is read before the send, the org revision is the request's `orgUpdatedAt`. A refusal is logged and the reservation expires with its lease. |
| `modules/delivery/delivery-actor.ts` `deliveryGrant` | Kept | The issuance resume on the creating request acts for the authority stored in the durable intent (the same member, after sign-out or on replay), with the revisions captured when the intent was written. The same intent is resumed by the sweeper under a job context. |


### 1.3 REPLACE and UPSERT guards (M2)

Tables under Rule 2 get BEFORE INSERT guards. Each aborts when a row with the same primary key or any unique key exists, matching the existing `0042:220` and `0047:36` pattern:

| Table | Migration |
| --- | --- |
| `org_memberships`, `org_invitations` | amend `0029` |
| `api_keys` | amend `0039` |
| `template_releases` | amend `0031` |
| `template_release_heads` | `0052`; the head trigger is the only writer |
| `scan_staff`, `scan_events`, `scanning_sessions`, `scanning_devices` (`scanner_id` is the key) | `0052` |
| `api_keys` ids after delete | `0052`: `retired_api_key_ids` records every deleted id and `api_keys_no_id_reuse` aborts a re-insert, so a deleted key's id is never issued again (D1 counts the retire row in a delete's `meta.changes`) |
| `template_versions` | none new: `template_versions_insert_immutable` (`0049`) aborts on an existing `(template_id, version)` or tombstone, so REPLACE cannot recreate a version |
| `sessions` | none new: `sessions_no_replace` (`0047:36`) |
| `credential_ref_keyset` | none new: `credential_ref_keyset_insert_guard` (`0042:453`) aborts when any keyset row exists, plus `credential_ref_keyset_no_update` and `credential_ref_keyset_no_delete` |

- **REPLACE allowlist (`check:rules`, §1.2):** every `OR REPLACE` / `REPLACE INTO` outside it fails.
  - `INSERT OR REPLACE INTO push_results` in `src/worker/modules/delivery/repo-devices.ts:142`. Safe: `push_results` is not a guarded or Rule-2 table, the row is a per-outbox result keyed `(outbox_id, device_id)` that holds no authority, and the statement is fenced by `pushFenceSql` and the registration check.
  - Wallet providers, migration helpers and test fixtures (§1.2).
  - Anything else needs a reviewed entry here, with the reason it is safe.
- **UPSERT:** `ON CONFLICT DO UPDATE` reaches the update guards, which already reject identity changes. WP0 tests UPSERT on every Rule-2 table anyway.
- **WP0 negative tests:**
  - `INSERT OR REPLACE`, `REPLACE INTO` and `INSERT … ON CONFLICT DO UPDATE` on every Rule-2 table must abort, with the row unchanged;
  - the same for each epoch'd table, with the epoch never decreasing;
  - the same for `template_versions`, `sessions` and `credential_ref_keyset`, which rely on their existing guards.

### 1.4 Read authority (M7)

`authorityPredicate(principal, now)` returns `{ ctes, params }`:
- the same flat `MATERIALIZED` CTEs as a grant check;
- no insert;
- org, membership or key, session or scanner, and epochs;
- used as `WITH ... SELECT ... WHERE EXISTS (SELECT 1 FROM actor_ok)`.

**Where it is used:** feeds, live polling, lookup, history, assets, exports.

**What GET handlers may write (corpus test, WP0):** only these allowlisted side effects:
- session idle slide (`auth/repo-sessions.ts:75`);
- scanner `last_seen_*`;
- rate-limit counters;
- idempotent cache fills, listed by name.

## 2. Fence family mapping

**Legend for the columns below:**
- **Durable:** re-checked against current rows in the grant.
- **Epoch:** compared through one epoch.
- **JS-once:** checked once at request start because the input is immutable.
- **Dropped:** removed. Every drop is justified in the row.

| Family (current site) | Durable | Epoch | JS-once | Dropped, and why |
| --- | --- | --- | --- | --- |
| F1 Tenant session and API-key authority (`passes/repo-authority.ts:11-43`, 41 files) | org active; membership id not revoked; user active; session live (synchronous requests only); key not revoked or expired; target `org_id`/`mode` = grant | `access_revision` | capability from membership roles or key scopes; session roles and amr | `o.updated_at`: settings and branding bump it (`settings/repo.ts:106`), it is not authority. `json(s.roles)`, `json(m.roles)` and the `json_each` role validation: immutable. |
| F2 Platform admin (`platformAdminSessionSql`, `orgs/repo-members.ts:29` bypass) | session live; user active | | admin role (session roles immutable) | `? = 1` bypass, replaced by the session check (W1-15) |
| F3 Pass snapshot equality (`scan/repo-pass-predicates.ts:140-210`, `passes/repo-connection-context.ts:40-55`, transfer source 38 columns, create-row post-check, `me` snapshot, sandbox capture) | id, org, mode; `lifecycle_generation`; `credential_generation`; `link_generation` where a link is disclosed; no pending transfer; `test_data_quarantined=0` for delivery | `row_version`, for derived writes only: publish, edit, image, member photo, removal claim, transfer, connection apply and refresh, bulk | | **Pass content and credential columns:** version, revision, personalization, image_generation, template_version and release_id. Content changes are not authority, and derived writers catch them through `row_version`. Holder email, owner, serial, auth token, scan code, barcode hash, download token and object key rotate only together with a credential or link generation (`0042:257` reservation trigger), except `barcode_hash` and `lookup_hash`, which a publish can rewrite (the scan grant compares the scanned hash directly; see the revision 2 changes below). `connection_id` is covered by `row_version`. **Snapshot re-reads:** the post-commit re-read compare (`create-row.ts:244-274`) and `me` `sameSnapshot` are reads, not authority (W1-16). |
| F4 Evaluated policy (`repo-pass-predicates.ts:282+`) | `t.status`, `t.org_id` direct; event match evaluated on the current pass row | release head (create and publish only) | keyset commitment | **Revision stamps:** `o.updated_at` (F1) and `t.updated_at` (a stamp). **Display-only state:** the wallet snapshot (pass JSON hash, identity revision, wallet version, personalization hash). **At scan commit:** the release head, because a newer release does not invalidate a ticket. **Tombstones at commit:** a matching `credential_generation` implies none, because the tombstone insert guard requires the generation to advance (`0042:398-410`). Tombstones stay at resolve time. |
| F5 Scan actor (`scan/repo-actor-authority.ts:27-150`, `repo-actor-scanner-authority.ts`, `repo-actor-csrf-authority.ts`) | org; admin per F1 plus session; scanner `revoked_at IS NULL`; `sc.staff_id = ?` bound staff; staff `disabled_at IS NULL`; scanning session `status='active'`; event `archived_at IS NULL`; scanned pass's template in `scan_event_templates` | `credential_epoch`, `config_epoch`, `auth_epoch`, event and session `config_epoch` | CSRF proof, verified against secrets that cannot change without a credential epoch bump (scanners) or at all (sessions, `0047`) | **Per-template release proofs for every scoped template:** only the scanned pass's template matters (W1-18). **Equality on 11 event columns and the `updated_at` revisions:** replaced by epochs. **CSRF proofs in SQL and in ledger rows:** checked in JS; the ledger copy was a leak (W1-05). |
| F6 Override ledger authority (`repo-action-authority-ledger.ts:102-153`, `repo-gates-authority.ts:245`) | immutable heads-up facts: scan id, org, mode, pass, action, scope, `actor_key`, outcome `heads_up`, `at` within the window, `scans_override_once`; current actor (F5); manager approval: staff role manager, not disabled | approver `auth_epoch` | approver PIN check (at request) | Historical org, template, scanner, session, event and staff revisions and CSRF proofs being equal to current ones. Authority is the current actor's, not a replay of the past one. |
| F7 Undo (`repo-undo-target.ts:28-115`, `repo-undo-gate-proof.ts`, `-presence-proof`, `-approval-guard`, `-replay-guard`, `-commit-guard`) | target scan: id, org, mode, `state='done'`, `outcome='ok'`, kind, `undone_by IS NULL`; gate CAS `last_scan_id=target AND last_at=target.at`; presence CAS; not in `scan_quarantine_exclusions`; actor F5 with the undo capability; approval when policy requires | actor epochs only | | **Pass and template drift:** pass version and revision, template and release, wallet, identity and the org and template revisions (W1-06). **Proof machinery:** the signed undo envelope, the JSON tokenizer, retention HMAC re-proof and the post-commit `answer()` fence. **Replay:** checks only the idempotency row. **Superseded undo:** a gate CAS miss with `last_scan_id ≠ target` returns 409 `UNDO_SUPERSEDED`. |
| F8 Output and disclosure (`repo-output-authority.ts:131-146`, `repo-output-predicates.ts`) | actor F5; pass lifecycle and credential generation; photo policy from the current row | | | `modified_at`, `refresh_requested_at`, `last_refreshed_at`, `sync_error_code`, `content_hash`, object sha256 and size, the `field_sources` json_tree, revision, `image_generation`, download token and object key. These are sync metadata (scan-write-2). The silent `'0'` fallbacks go away because statements are now bounded. |
| F9 Retention (`repo-scan-retention.ts`, `0041`, `0051`) | row flags (`excluded=0`, `invalidated=0`), quarantine exclusion and pass existence, read directly; purge uses a `system:` grant | | | Per-statement HMAC re-verification of server-held rows. Insert triggers already guarantee integrity once. Anyone able to forge rows can also run the Worker, so the HMAC protects against no actor in scope. W3-02 decides which proof tables to drop. |
| F10 Credential keyset (`credentialRefKeysetSql`, 80 files) | | | commitment pinned once per request (`requireCredentialRefKeyset`) | Inline SQL in non-provider modules: the row is immutable (`0042:491-494`). The helper stays exported for wallet providers. |
| F11 Connections: context, runs, item claims (`repo-connection-context.ts`, `repo-webhook-item-claims.ts:88-170`, `repo-runs.ts:106-113`, SYNC_GUARD, REFRESH_GUARD) | connection id and org; `enabled=1`; org access; pass bound to (`connection_id`, `external_ref`); lifecycle and credential generation; no pending transfer; retention row state | `connections.generation`; `passes.row_version`; release head (admit and create) | keyset | **Pass snapshot and keyset:** the 23-value pass snapshot, the retained binding triple and the keyset SQL. **Legacy proof columns:** the 12 `legacy_*` columns become `legacy_pass_row_version`. **JS rechecks:** the repeated `fenced()` rechecks (`records.ts:158-246`) are dropped; there is one grant per write batch. |
| F12 Delivery binding, P1-1 (`delivery/repo-binding.ts:42-131`, `binding.ts`) | recipient = `p.holder_email`; owner; credential, lifecycle and link generation; `status='active'`, not removed or quarantined; no pending transfer; org access | `access_revision` | | Version, revision, object key, download-token hash and release. The send attaches the current artifact (the claiming UPDATE returns `object_key`). A content refresh no longer cancels mail; this was P1-1's listed side effect. |
| F13 Issuance intent (`repo-issuance-intent-fence.ts:12-164`) | lineage: intent pass, org, mode, identity, lifecycle generation, recipient, and either the source credential generation or a completed transfer whose `target_generation = p.credential_generation`; principal membership not revoked and user active, or key not revoked | org `access_revision` captured at intent | capability | **Session liveness:** the creator's session, idle expiry, `o.updated_at` and the roles JSON (W1-07). **Unreachable check:** the sample scanner scope (delivery finding 11). **Snapshot and secrets:** the version, revision, serial, auth token, download token and object key snapshot. The stored secrets are removed. **Release at output:** a created pass may be sent. The release is checked at create. |
| F14 Bundles (`bundles/repo.ts:218-228`, `repo-public.ts:56-98`, `public-service.ts:94`) | bundle token; each member row still present in `bundle_passes`, checked once when the stream opens (transfer START deletes it) | | | **NOT NULL error-text matching:** the grant's RAISE reasons replace it. **Per-chunk re-fence:** dropped; responses are immutable-cached anyway (delivery finding). |
| F15 Releases (`templates/repo-releases.ts:199-310`) | release id (immutable row); template status and org | head table | adapter revision and capabilities constants | Re-proof of the candidate and approval join on every read. The `template_releases_insert` trigger (`0031:92`) enforces it once, and rows are immutable. |
| F16 Settings and org edits (`settings/repo.ts:80-112`, `orgs/repo.ts:95`) | F1 | `config_revision` (CAS, 409) | | Bumping `updated_at` as an authority epoch |
| F17 Sandbox capture (`sandbox/repo-capture.ts:49`, W1-14) | org, mode, membership; for forwarding only: pass lifecycle and credential generation; `PROVIDER_RETIREMENT_COMPLETE` unchanged | | | Snapshot fence on visibility |
| F18 Display history, asset grants, live hub (W1-08, W3-02) | actor F5 when fetched | | asset grant = stateless HMAC token (purpose, pass, generation, expiry) | Per-row history proof CAS statements (`scan-display-history.ts:243`) |

**Revision 2 changes to the table:**

**F3 pass snapshot (minor 4).** A publish rewrites `barcode_hash` and `lookup_hash` with only a version bump (`passes/repo-write-publish.ts:150`), so "credentials rotate only with a generation" is false for those two columns. The scan grant therefore also compares the scanned credential directly against the current row: `p.barcode_hash = ?`, `p.lookup_hash = ?` or `p.scan_code = ?` (one, by input kind). A ticket whose code was replaced by a publish is refused with `lineage`.

**F5 scan actor (minor 7).**
- Add `sc.expires_at IS NULL OR sc.expires_at > now`.
- `guard.ts` reads `credential_epoch` in the same row read that verifies `token_hash` and the CSRF secret.

**F5 / F10 against the W1-15 staff PIN reset (M6).**
- **What W1-15 did:** put CSRF and keyset fences in SQL (`scan/staff-admin.ts:262-290`).
- **Rule:** under Rules 2 and 5, both checks run once in JS:
  - the session CSRF secret is immutable (`0047`);
  - the keyset is an immutable singleton.
- **What WP9 does:** converts the reset to `grant` with membership, session, `auth_epoch` and org checks.
- **Security level:** equal. The SQL copies re-checked values that cannot change under the request.
- **Until WP9 lands,** the W1-15 SQL stays as it is.

**F6 / P1-3e (minor 16).** Native acknowledgements (W2-08) bind to `scanners.config_epoch` plus the scan id, so an acknowledgement for an older configuration is rejected.

**F11 connections.**
- Connection grants are `org_mode` with `mode = 'live'`, enforced by CHECK (M5).
- Perpetual syncs are standing jobs and check `o.status = 'active'` directly (Rule 4, owner answer 9): they pause while the org is suspended and resume after reactivation.

**F13 issuance and deferred work by platform or system callers (missing item).**
- A platform admin has no membership. Their deferred work records `principal = 'platform:<user_id>'`.
- At output it checks:
  - user active and not disabled since queueing;
  - an admin session for that user that existed and was live when the work was queued;
  - the captured org `access_revision`;
  - lineage.
- Later sign-out does not cancel it (owner answer 2). Disabling the user stops it: the disable batch cancels their queued work, which stays cancelled if the user is re-enabled (owner answers 3 and 9).
- `system:` work checks only org status or `access_revision`, plus lineage.

**F14 bundles (minor 9).**
- **Load-bearing for P1-1:** the transfer START batch runs `DELETE FROM bundle_passes WHERE pass_id = ?` (`passes/repo-credential-transfer.ts:233`).
- When the stream opens, the check is that the bundle token is valid and each member row still exists in `bundle_passes`. There is no per-member generation compare.
- Test: start a transfer, then the old bundle link no longer serves that pass.

**Settings-table policy (missing item; residual risk R8).** Org settings that change scan decisions (for example `letInAgain`) are read at preflight and not compared at commit. A scan racing a settings save may use the previous settings for that one scan. `config_revision` could close this, but at the cost of 409s at the door on every settings save. Accepted (owner answer 8): no fence, no 409 at the door.

## 3. Security argument

| Item | Why it still holds |
| --- | --- |
| P1-1 cross-person access | A holder change requires a transfer. The transfer bumps `credential_generation` (reservation trigger `0042:257`) and `link_generation`, tombstones the old refs and deletes registrations. Every disclosure and delivery statement checks the generations and "no pending transfer" in the same statement that sets the provider marker. |
| P1-2 test and live, explicit release | Mode is fixed in the grant and every target predicate requires `mode = g.mode`. Create requires the release to be the current head for (template, org, mode), checked in the grant. Releases are immutable and approval is enforced at insert (`0031`). Quarantine drives `lifecycle_generation` (`0042:274`) and is checked directly for delivery. |
| P1-3a, b, c, e | Projection, policy and contract fixes; not touched. |
| P1-3d | The manager check becomes the approver's `auth_epoch` plus `role='manager'`. W1-05 adds the `capacity_override` kind. |
| P1-4 mutable ownership and lifecycle at commit | Void, removal and quarantine are covered by `lifecycle_generation` in the grant. Template reassignment is caught by checking `t.org_id` against the grant org at commit, not from cache. The registry-cache residual stays with W1-09. |
| P1-5 | Not touched. |
| P1-6 | Memberships stay durable and each principal kind is explicit. The platform-admin bypass now requires a live admin session in SQL. |
| P2-1, P2-4 to P2-10 | Not touched. |
| P2-2 | Claim semantics are unchanged. Refusals become classified instead of no-ops. |
| P2-3 | `authority_denied:*` is a definite rollback, so deleting the R2 object after it stays safe. Ambiguous errors still keep the object. |

**Invariants:**
- **Tenant isolation, org AND mode:**
  - For org principals, the grant's org comes from the principal row the check joins. For platform principals it comes from the target row, which the check requires to be active (§1.2). It is never taken from the request.
  - Every write takes `org_id` and `mode` from `authority_grants`.
  - The typed builder (M3) is the only way to build a guarded write: it injects org and mode from the grant row, and its statements commit only inside their own grant's batch.
  - Each package's tests include cross-org and cross-mode attempts.
- **Credential-generation fencing:** columns and triggers are unchanged (`0042`, `0043`, `0050`). Resolve still refuses tombstoned refs, and commits compare generations.
- **Retention:** retained and quarantined rows keep their insert and update triggers. Undo and override of retained scans are refused by direct flags. Purge runs under a `system:` grant with `providerRetirementCompleteSql` unchanged.
- **CSRF and session binding:**
  - CSRF is verified at request start against secrets that cannot change without a new session (`0047`) or a `credential_epoch` bump.
  - The grant binds the session `id_hash` or the scanner's `credential_epoch`, so a request authenticated with a rotated credential cannot commit.
- **Idempotency:** claim tables and pristine-claim fencing are unchanged. A replay returns the stored result without a new grant. A write that never committed re-runs with a fresh grant.

**Residual risks (named):**
- R1. JS-once checks are only as sound as the immutability triggers (`0029`, `0039`, `0047`, `0042:491`). A schema test asserts those triggers exist.
- R2. A column misfiled as volatile hides a real change from `row_version`. Authority columns (status and generations) are compared directly, never through `row_version`. Classification is reviewed and enforced by test.
- R3. Deferred work survives the initiator's sign-out by design. The kill switch is revoking the membership or key, or suspending the org. `docs/security.md` offboarding must say so (W1-03).
- R4. A scan result may show content a few milliseconds older than a concurrent publish. Not authority.
- R5. The provider call after the marker commit is outside the transaction, same as today.
- R6. Users have no epoch. Disabling a user revokes their sessions in the same batch (`users/repo.ts:155-165`) and counts as revocation for their queued work (owner answers 3 and 9). The same batch cancels the user's queued one-shot work, so it stays cancelled if the user is re-enabled.
- R7. Wallet-provider fences stay column-equality this release (dark, gated). Their correctness does not change.

**Revision 2 additions:**

**Rule-2 immutability now also holds against REPLACE and UPSERT** (§1.3). Without that, P1-6 and API-key scope delegation (W1-15) were bypassable by any code path that issues `OR REPLACE`. `check:rules` closes that path.

**Tenant isolation:**
- Typed statements inject `org_id` and `mode` from the grant.
- Raw guarded writes are banned by lint.
- Mode-less purposes are explicit (`org`, `platform`).
- Connection grants are live only (P1-2).
- `system:` grants cannot come from routes.

**W1-15 items stay closed:**
- API-key scope delegation: `delegableScopes` in JS against the creator's immutable membership roles, and the grant binds the creator's membership id. Equivalent to the current SQL check (WP1 keeps that SQL until it converts).
- Broadcast creator: membership not revoked, with `messages:manage` derived from immutable roles.
- Platform-admin `AdminFence`: the F2 grant check.
- Last-org_admin protection: a grant CTE counting other active `org_admin` memberships, evaluated in the same transaction.
- Invitation compensation: unchanged.
- OIDC mail proof: unchanged.
- Staff PIN reset: see F5/F10 above.

**Events API (M6).** `toEventDto` strips `authority`, `*Proof`, `*Csrf*` and keyset fields from every row, old rows included. WP5b adds the test.

**More residual risks** (in addition to R1-R7 above):
- **R8.** Settings policy is not fenced at commit (above). Accepted (owner answer 8).
- **R9.** Retention HMAC re-verification is dropped and documented. An operator holding a D1-edit-only API token is out of scope; that actor can also edit memberships and sessions directly. Accepted (owner answer 7).
- **R10.** Write failures in the cutover window (§6), contained by the WAF rule (owner answer 5).

## 4. Wrong outcomes removed

| Finding | Removed by |
| --- | --- |
| Lost gate race shows `refused/not_found` (`scan/act.ts:177`) | The gate UPSERT and finalize run in the grant batch. Finalize writes `ok` only if the gate points at this scan, otherwise `heads_up` naming `gate.last_scan_id`. `StaleScanAuthority` catch-alls go; the remaining refusals carry a reason (`config` → `SCAN_CONFIG_CHANGED`, `actor` → 401/403). |
| An assertion rollback quarantines the idempotency key (`act-claim-lifecycle.ts:124`) | Assertions become RAISE reasons. A classified abort is definite, so the key is released. |
| "Let in again" fails after a staff sign-in or any revision (`repo-action-authority-ledger.ts:140`, `repo-device.ts:122`) | F6. Staff sign-in moves no epoch. |
| Committed check-in returns 409 `SCAN_UNCONFIRMED` (`act-check-in-result.ts:95`) | No post-commit fence. Display history comes from aggregates (W1-08). |
| Bind overflow silently becomes `'0'` (`repo-gates.ts:257`, `repo-output-predicates.ts:205`) | Statements are ≤40 parameters by construction, and `stmt()` throws `SQL_BIND_BUDGET`. |
| Output fences fail on sync fields (`repo-output-authority.ts:131`) | F8 |
| Undo returns 404 after any org, template or pass revision (`repo-undo-target.ts:112`, `scan-undo-proof.ts:96`) | F7 |
| Undo replay is not idempotent (`repo-undo-replay-guard.ts:39`) | Replay checks the idempotency row only |
| `UNDO_SUPERSEDED` removed (`undo-replay.ts:22`) | A gate CAS miss returns 409 `UNDO_SUPERSEDED` |
| Scans from before the branch cannot be undone (`repo-undo-proof.ts:143`) | No ledger authority is needed |
| Issuance mail cancelled by sign-out, idle expiry or an org edit (`repo-issuance-intent-fence.ts:83`) | F13 |
| `DELIVERY_STALE` on any version bump (P1-1 residual) | F12 |
| Idempotent replay returns 409 (`issuance-intent.ts:124`); committed create returns 409 (`create-row.ts:241`) | The replay returns the stored result, and there is no post-commit re-fence |
| Issuance INSERT binds 94 parameters (`repo-issued-email.ts:168`) | ≤40 (section 5) |
| `orgs.updated_at` used as an epoch gives 403 on settings saves, and bulk actions abort (`repo-authority.ts:23`, `settings/repo.ts:107`, `repo-scanner-configuration-predicate.ts:92`) | `access_revision`; settings CAS returns 409; each bulk item gets its own grant |
| Transfer START binds 97 parameters; a release approved mid-transfer wedges it (`repo-credential-transfer.ts:153`, `credential-transfer.ts:233`) | `row_version` and INSERT…SELECT. Finish compares `row_version` and the current head. W1-11 owns the abandon path. |
| One unusable template disables the door (`repo-scope.ts:146`) | F5: only the scanned pass's template is checked |
| A revision race logs the device out (`guard.ts:263`, `session-activity.ts:233`) | Only a `credential_epoch` mismatch unpairs. Config changes return 409 and the client refetches. |
| Report and staff sign-in return 409 after commit (`scanning-workspace-report.ts:169`, `routes-staff-session.ts:97`) | The grant is the check; the post-commit compare is deleted |
| Captures vanish after a pass edit (`sandbox/repo-capture.ts:49`) | F17 |
| The connection fence budget is unmeasured, about 40+33 queries per ref (`query-budget.ts:16`, `records.ts:158`) | One grant per item write; budget re-measured in WP4 |
| sql-balance would corrupt expression-position `FROM` (`platform/db.ts:20`) | Removed (WP8) |

**Revision 2 additions:**
- **Retry after a lost response returns 409 for the user's own change:** removed by the idempotency key or the post-state check (§1.2).
- **The lookup backfill bumps every pass after cutover:** removed by the `OLD.x IS NOT NULL` rule for `scan_code`, `barcode_hash` and `lookup_hash`.
- **An event config edit makes door devices return 409:**
  - the scanner client refetches its config and retries once with the same idempotency key, automatically;
  - only a second 409 reaches staff.
  - Test: a scan sent while the event is being edited returns `ok` after one retry.

## 5. Limits

Estimates come from the statement shapes above. WP0's corpus test records the real numbers and enforces them.

| Statement | Parameters | Size | Nesting (EXISTS levels) |
| --- | --- | --- | --- |
| Grant, tenant session (pass write) | 11-13 | ~1.6 KB | 1 |
| Grant, API key | 10 | ~1.3 KB | 1 |
| Grant, scan check-in (scanner, staff, session, event, pass, scope) | ≤22 (+3 for an admin principal) | ~2.5 KB | 1 |
| Gate UPSERT / scan finalize / ledger insert | ≤14 / ≤30 / ≤8 | <2 KB | 1 |
| Grant, undo; gate restore; undo scan insert | ≤20; ≤6; ≤30 | <2.5 KB | 1 |
| Pass publish UPDATE | ≤30 | <2 KB | 1 |
| Transfer START: grant; transfer INSERT…SELECT; rotate UPDATE; tombstone INSERT…SELECT | 12; ≤15; ≤10; ≤6 | <2 KB | 1 |
| Issuance: grant + outbox INSERT; output claim | 14 + 6; ≤14 | <2 KB | 1 |
| Connection item: grant + claim UPDATE | ≤14 + 6 | <2 KB | 1 |
| Settings save: grant + per-key upsert | 11 + 4 | <1.5 KB | 1 |

- **Depth:** CTE bodies are flat joins, and the CASE reads CTEs that are FROM items, so the D1 height problem does not arise. The worst case is roughly 10 against a limit of 100.
- **Hard caps in `db.ts`:** writes ≤40 parameters (asserted in tests), all statements ≤90 parameters and ≤32 KB. A breach throws `SQL_BIND_BUDGET` or `SQL_SIZE_BUDGET`.
- **`sql-balance.ts` and `sql-tokens.ts`:** removable once WP5-WP7 land. The statement-corpus test runs every statement the worker tests produce with balancing off, using `EXPLAIN` on local D1. Statements that may still need it are reads I have not measured: `repo-feed-scope.ts` and `repo-scope-release-predicates.ts`. The release-head table should remove their depth. Any statement that still fails is restructured into CTEs in its own package; none is re-balanced. Triggers never went through `stmt()`.

**Revision 2 additions:**
- The grant insert binds one more value (`scope`).
- The pass bump trigger is split into three (§1.1).

Every write is still at most 40 parameters.

## 6. Migration and cutover (M1, M4)

### 6.1 Migration ownership

| Migration | Change | Owner |
| --- | --- | --- |
| `0029` | `access_revision` with its bump and monotonic triggers; role-name insert guard; no-replace guards | WP0 |
| `0031` (with the cutover agent's `legacy` source) | `template_releases` no-replace guard | WP0 |
| `0039` | `api_keys` no-replace guard | WP0 |
| `0042` | **Transfer guards.** `pass_credential_transfer_insert_guard` (85-117), `pass_credential_transfer_complete_guard` (119-171) and `pass_credential_generation_reserved` (257-269) compare `row_version` (a new `pass_credential_transfers.source_row_version` column) and the current release head instead of version and revision, version + 1, connection generation and the release equalities. **Kept:** generation, link and holder checks. **Untouched:** provider-instance clauses. | WP2, merged with W1-11 |
| `0043` (with the alias fix as baseline), `0050` | none | provider track |
| `0044` | `legacy_*` and `claim_snapshot` become `legacy_pass_row_version` and `claim_row_version` | WP4, after W1-12a lands its `0044` changes |
| `0045` (with the cutover agent's push payload backfill) | `pass_issuance_delivery_insert_guard` (49-64) and the snapshot columns become generations plus `transfer_id`; drop the secret copies | WP3 |
| `0047` | add `roles` and `amr` to `sessions_authority_immutable`. Keep `scanners_credential_revision` until WP8 proves (with `check:rules`) that no `updated_at = ?` comparison remains, then drop it in WP8. | WP0 (roles and amr), WP8 (the drop) |
| `0041`, `0051` | drop unreferenced proof tables and triggers | WP7 (retention), WP5b (passless) |
| `0052_authority_epochs.sql` | epochs and triggers, heads, grants, no-replace guards for the new guarded tables, sentinel FK (mandatory if the WP0 spike shows D1 enforces deferred FKs) | WP0 |
| `0052` (amended by WP-T) | `template_version_hashes (template_id, version, content_hash, asset_hashes, created_at)`: the per-version content hash and per-asset sha256 (W1-09), write-once (update, delete and replace abort), beside the immutable `template_versions`. Written at candidate creation and baked sync; issuance compares `content_hash` with the release in SQL. No backfill: a release whose version has no row is verified from its bytes at its first issuance and the row is then saved; a row that differs from the release makes it ineffective; `legacy` releases are exempt. | WP-T |

Integration signs off on every migration change.

**Backfill:**
- Default 1 on the new columns, with no row rewrites.
- Heads are filled from `template_releases`, including `legacy` rows created by the bootstrap tool through the trigger.
- `pass_credential_transfers.source_row_version` gets `1` (no production rows exist).

**Fixtures that abort after the `0047` amendment** (they update `sessions.roles`) are obsolete:
- `scan/repo-commit-fence-action-test-fixtures.ts:122`
- `repo-act-authority-sessions-cases-test-fixtures.ts:204`
- `repo-scanning-authority-admin-session-test-fixtures.ts:95`
- `repo-counts-cache-admin-cases-test-fixtures.ts:46`

Revoke the session instead.

### 6.2 Cutover window

**`tools/deploy.ts` (cutover agent), run as `--migrate-only` and `--promote` (§6.4):**
1. Secret list.
2. `versions upload`.
3. Bookmark.
4. Migrate 0025–0055. `--migrate-only` stops here.
5. `tools/bootstrap-tenancy.ts`: memberships, legacy releases, queued mail bound (owner runs it, remote).
6. `versions deploy` (`--promote`).

Between steps 4 and 5 the baseline Worker serves against the new schema. Migrations 0025-0051 already break some baseline writes. `0052` adds one known break (the baseline `ensureOrgStmt`, below): every new column has a default, guards reject only decreases, grants are unused, and the no-replace guards refuse only a statement that hits an existing key.

**Baseline write paths, as an allowlist for the compatibility test (WP0).** The test applies all migrations, then runs each baseline write from `8f5bee02` and asserts the expected result.

| Baseline path | Expected in the window | Why |
| --- | --- | --- |
| Holder edit (`holders/repo.ts:220,234`) | **fails** | `0042 pass_credential_transfer_required` |
| Pass create without a release (`passes/repo-write.ts` `insertPass`) | ok (verified): `0031` requires a release for a published pass, not at insert | release at publish |
| Org settings upsert, org profile and branding stamp | ok (verified); each moves `orgs.config_revision` | `0052` triggers |
| Template upload (uploaded template and first version), baked template upsert | ok (verified) | |
| Template sync `ensureOrgStmt` (`orgs/repo.ts`, `INSERT ... ON CONFLICT (slug) DO NOTHING`, HEAD `templates/sync.ts:80`) | **fails** for an existing slug, ok for a new one | `0052 orgs_no_replace` aborts where `DO NOTHING` skipped (BEFORE INSERT guards ignore `ON CONFLICT`) |
| Template sync version insert (`INSERT OR IGNORE INTO template_versions`) re-sent | **fails** | `0049` insert guard |
| Scanner pairing, pair-code issue and heartbeat; scan check-in claim (`INSERT INTO scans ... ON CONFLICT DO NOTHING`) | ok (verified) | |
| Connection sync writes | ok (verified): the generation fence still works | `0044` guards; the bump trigger waits for WP4 |
| Every other baseline write | listed by the test, never assumed | |

**In-window break: `ensureOrgStmt` and template sync.**
- The baseline sync batch runs only when the stored build hash differs from the Worker's. The baseline build already synced its own hash, so the old Worker skips the batch for the whole window; the break appears only if a fresh baked build reaches it (a new build hash) or the `templates.baked_hash` system setting is cleared.
- In that case the batch aborts as a whole (the `orgs` insert hits `orgs.slug`) and the next request retries it. No data is written, so the effect is a delayed baked-template sync, not corruption. The new Worker's `ensureOrgStmt` is `INSERT ... SELECT ... WHERE NOT EXISTS` and is unaffected.
- Accepted as a known break; `authority-baseline.test.ts` pins both outcomes.

**Containment:**
- The window is automated (seconds to minutes).
- Known-failing admin write routes (holder edit) are blocked between migrate and promote with a temporary Cloudflare WAF rule that returns a short maintenance response. The baseline Worker cannot read a new flag. Pass pages, Wallet updates and scanning are not blocked. Owner answer 5.

**Queues:**
- Draining is best-effort, because the baseline keeps enqueuing during the window.
- The guarantee is that the new consumer accepts baseline-shaped messages (W1-12a: logged and retained as ignored; W1-02: push payload backfill).

### 6.3 Rollback runbook

Forward-only database. Once migrations have run, roll forward only (owner answer 6). The Worker-only rollback below is an emergency degraded mode, not a normal option.

**Before rolling back:**
1. Pause queue consumers (`wrangler queues pause-delivery`), so the baseline never sees new-shape messages. The baseline would ack them as invalid.
2. Block transfer-starting routes with the WAF rule.

**While rolled back:**
- Pending transfers, `0045` delivery rows and paused messages stay as they are. Holder edits keep failing under `0042`.
- Rollback is therefore an emergency degraded mode, used only to stop an outage.
- The fix is to roll forward: redeploy, then resume delivery.

**Tests:**
- Rollback with new-shape messages is exercised on a preview database.
- A Time Travel restore to the bookmark is the last resort; it loses writes made after the migration (W1-03).

### 6.4 Cutover rehearsal and decisions (2026-11-11)

`test/cutover/` migrates a populated 0024 database through 0055, runs the bootstrap and the baked sync, and exercises it. Shapes: unassigned baked, baked assigned to an org, baked assigned with no passes, a starter assigned to an org by the old `PATCH` (`baked-patched`), uploaded active, uploaded archived, uploaded with no passes; plus a live pass in a deleted org. Each has live passes (except the empty ones), a pre-cutover check-in, a queued push and a queued pass email. The runbook is `docs/operations.md`, "Cutover from schema 0024"; its SQL blocks are executed by the test.

**Findings and fixes:**

| Finding | Fix |
| --- | --- |
| Queued pass email (`{ to, attach }`, no `intent`) cancelled as `DELIVERY_UNBOUND`; the legacy intent path was unreachable for real 0024 rows. | `bootstrap-tenancy` writes `payload.intent` (no `actor`, so `legacy: true`) for unsent pass and bundle mail from the current pass and bundle state. SQL cannot hash the download token, so this is the tool's job, not a migration's. The row is bound only while the pass is the one the snapshot saw. |
| Assigned baked templates have no release until the baked sync runs. | See below: the sync owns it. No code change. |
| Passes pinned to an older template version were refused (scan `not_found`, refresh `TEMPLATE_RELEASE_CONFLICT`); a new baked build makes every baked pass stale. | Fixed: issuance and use are separate. Use of an existing pass (scan, display, undo, history, refresh at its own version) depends on the pass being live, its template not deleted and its own issued release (or, with no `release_id`, its own `template_version`). A compatible head (same version or build) is still followed so display-only edits reach old passes. `reissueStaleTemplates` upgrades the rest. |
| Archived uploaded templates: no effective release; scan refused (`SCAN_PASS_CHANGED`). | Fixed: archived templates keep scanning and refreshing existing passes; new issuance still needs the head, so it is refused. Only `deleted` stops a pass. |
| Deploy ran migrate and promote in one command, leaving no slot for the bootstrap. | `--migrate-only` and `--promote`. |
| `wrangler d1 execute --command` with the snapshot SQL was fragile to quote. | The tool writes `.wrangler/bootstrap-snapshot.sql` (`--print-remote`); the owner passes it as `--command "$(cat …)"`. Not `--file`: a remote `--file` runs through D1's import API, which returns counts, never rows (`tools/lib/bootstrap-tenancy.test.ts`). |
| Compound `SELECT` is capped at 5 terms in D1 (found by running the runbook queries). | The count query is one `json_object`. |
| Deleting an org keeps its passes. An active uploaded template in a deleted org gets no legacy release (the bootstrap skips deleted orgs), so `verify-heads` listed it and `--promote` would exit 1. | `verify-heads` skips deleted orgs; nothing serves their passes. |
| `0055` lets the old Worker's owner link (pass create, sign-in) and self-remove succeed in the window. | WAF table updated; `test/cutover/window.test.ts` runs the old statements. |

**Assigned baked templates: the baked sync creates the org-scoped release, not the bootstrap.**

- `effectiveReleaseIdSql` honors a `legacy` release only for `origin = 'uploaded'`; a baked template needs a `system` release with `org_id = templates.org_id`. A bootstrap `legacy` release for a baked template would be ignored, or would need the predicate widened (module code) and a second provenance for baked content.
- A `system` release needs the verified content hash, the `template_version_hashes` row and the sealed preview extras. Only the sync computes them.
- The sync already scopes by the stored `templates.org_id`, so a PATCH assignment (or a manifest `org`) from the old Worker gets its org release and an unassigned template gets the platform release. The test proves both (`baked-assigned`, `baked-patched`: a starter with no manifest org, assigned by PATCH, gets `system` releases in that org, none from the bootstrap, and its passes scan, refresh, undo and send queued mail), including the legacy `templates.baked_hash` adoption path.
- Cost: until the sync runs, baked templates cannot issue new passes; existing baked passes still scan at their own version. `--promote` calls `GET /api/v1/templates` with a `templates:read` key, which runs the sync, and waits for `verify-heads`; the minute cron (`templates.sync`) is the fallback.
- Adoption needs `CF_VERSION` (`version_metadata` binding) so the new build's upload time is ordered after the old Worker's last sync; without it a changed hash counts as superseded and the sync skips.

**Deploy mode.** `wrangler.jsonc` is identical at `main` and HEAD, so the normal version flow applies (§6.2); `--first` would serve before the bootstrap.

**In-window old writes.** `authority-baseline.test.ts` pins the list above; `test/cutover/window.test.ts` pins the old holder writes against 0025–0055. Holder edits and delete of an owned pass fail. Since `0055`, the old attach hooks (pass create for a holder with an account, sign-in of a holder with a waiting pass) and owner release (`DELETE /api/v1/me/passes/{id}`, block row first) succeed, without the new credential the new Worker would issue. The WAF rule covers the admin and integration writes and owner release; sign-in is left open (operations.md, "Temporary WAF rule").

## 7. Implementation plan (B1, M6)

### 7.1 Order

1. WP0
2. WP1, WP-T and WP5a in parallel
3. WP2, WP3, WP4, WP5b, WP6, WP7 and WP9 in parallel
4. WP8

Every file matching these patterns has exactly one owner (Appendix A, generated on 2026-11-11 from the code):
- `updated_at\s*=\s*\?`
- `tenantPassAuthoritySql|tenantPassWriteSql`
- `repo-secret-binds`
- `credentialRefKeysetSql`
- `platformAdminSessionSql`
- `activeRelease*|noScopedReleaseSql`
- `changes()`
- a write to a guarded table

WP0 adds `tools/authority-scope.ts`, which re-runs the scan and fails when a new match has no owner.

### 7.2 Packages

| WP | Scope | Safety (must refuse) | Liveness (must succeed) |
| --- | --- | --- | --- |
| WP0 Platform | `0052`; amendments to `0029`, `0031`, `0039` and `0047` (roles); `platform/{authority.ts,db.ts,errors.ts}`; `jobs` context brand; `test/setup` leak check; classification, immutability, REPLACE and corpus tests; `tools/authority-scope.ts`; `check:rules` entries (warn mode). **Spike:** `recursive_triggers`, deferred FK, RAISE inside CASE, `?NNN` counting, depth of the split triggers, RETURNING. | REPLACE and UPSERT on Rule-2 tables; a statement mentioning the grant with a request-bound org fails lint; a statement run outside its batch throws; `g.joined` with a request-bound org or mode fails lint and the corpus test; a `system:` grant from a route is refused; deny precedence (org beats stale); a leaked grant is detected | volatile columns never bump; baseline allowlist matches |
| WP1 Tenant authority | Appendix A, WP1. Keeps the `tenantPassAuthoritySql` and `tenantPassAuthorityParams` signatures as a compact drop-in, so the three wallet-provider callers (`repo-{samsung-verification,account-writes,status}.ts`) compile unchanged (minor 15). Converts W1-15's `api-keys/repo.ts`, `orgs/repo-members.ts` and `broadcasts` checks to grants. Replaces the `users/repo.ts:155-165` `changes()` chain with a platform grant (minor 13). | revoked membership, session or key; suspended org; suspend then reactivate; cross-org; cross-mode; last org_admin; key scope escalation | settings or branding save during create, bulk or import; stale settings save returns 409 |
| WP-T Release heads | Appendix A, WP-T | unapproved or foreign-org release never becomes head; legacy release only when the scope is empty | baked fallback with org-over-platform precedence; a release approved mid-request does not refuse unrelated scans |
| WP2 Pass writes | Appendix A, WP2; `0042` transfer guards; with W1-07 (create) and W1-11 | concurrent edit returns 409; transfer or void between read and write gives `lineage` | with a transfer pending, approve a release and edit the connection: the transfer completes or abandons, never aborts; sync metadata does not fail an edit; transfer finish works with providers dark; lost-response retry returns 200 |
| WP3 Delivery, bundles, sandbox capture | Appendix A, WP3; `0045` | holder transfer, revoked membership or key, suspended org, quarantined pass; transfer start removes the pass from old bundle links | sign-out, idle expiry, branding edit, content refresh: mail is sent; idempotent replay returns 201 |
| WP4 Connections | Appendix A, WP4; `0044` | config change mid-run gives `STALE_GENERATION`; disabled connection; a test-mode grant for a connection purpose violates the CHECK | health, cursor and `next_run_at` writes; suspend then reactivate resumes syncs |
| WP5a Scan actor checks | Appendix A, WP5a; `guard.ts` captures epochs | scanner credential rotated between auth and grant gives 401; expired scanner; disabled staff | staff sign-in elsewhere |
| WP5b Scan write | Appendix A, WP5b, including `events/service.ts`, `rules.ts`, `outcome.ts`, `src/web/scan/api/to-fail.ts`; W1-05 criteria; `0051` passless drops | void or transfer between preflight and commit; a publish-replaced barcode is refused; capacity override needs a manager; `/passes/:id/events` never returns authority or proof fields, including old rows | 10-scanner race gives 1 `ok` and 9 `already_done`; override after staff re-sign-in; round trips ≤5 / ≤4 |
| WP6 Scan undo | Appendix A, WP6; W1-06 criteria | `UNDO_SUPERSEDED`; revoked actor; quarantined scan | undo after a settings save, a publish, a release approval; undo of scans from before the branch; retry after commit |
| WP7 Scan reads | Appendix A, WP7, via `authorityPredicate`; `0041` retention drops. **Coordination:** W1-17 owns the projection logic in `repo-feed*` (WP7 changes only their authority predicate); W1-13 keeps the backfill logic in `repo-lookup-backfill.ts` and WP7 converts its fence. | revoked actor cannot read feed, live data or assets; cross-mode | sync touch does not blank output; GET issues no writes outside the allowlist |
| WP9 Scan admin and config writes | Appendix A, WP9: scanners, pairing, devices (P1-3c contract from W1-18 kept), sessions, setups, events, staff (including the W1-15 PIN reset), configuration, workspace report, staff session; retire `scanning_config_revisions` readers | revoked or rotated scanner; cross-org event or staff; name-only PATCH keeps the role (403 `SCREEN_ONLY`) | report and staff sign-in never 409 after commit; config edit returns 409 then refetch, without unpairing |
| WP8 Cleanup | delete `platform/{sql-balance.ts,sql-tokens.ts}` and `scan/repo-secret-binds.ts`; drop `scanners_credential_revision`; `credentialRefKeysetSql` stays only in `passes/repo-credential-keyset.ts` and wallet providers; `check:rules` blocking | corpus with balancing off | `npm run check` green |

### 7.3 Wave-1 reconciliation (M6)

| Wave-1 task | Status | Effect here |
| --- | --- | --- |
| W1-05, W1-06, W1-07, W1-10, W1-11, W1-18 | owner answer 1 | built as WP5b, WP6, WP2/WP3, WP1, WP2 and WP9 |
| W1-15 | done | WP1 and WP9 convert its SQL fences to grants with equal security (§3); until then they stay |
| W1-17 | | owns feed projections; WP7 changes only predicate imports in `repo-feed*` |
| W1-13 | | keeps the backfill logic in `repo-lookup-backfill.ts`; WP7 converts its fence (Appendix A). The `OLD IS NOT NULL` trigger rule makes it bump-free |
| W1-12a | | lands `0044` first; WP4 amends after it |
| W1-02, W1-03 | done | §6.2 builds on the cutover agent's `0030`, `0031`/`0038`, `0043` and `0045` amendments and the new `deploy.ts` order |
| W1-04 | done | `/api/v1` keeps `If-Match` / 412 on `version` |

### 7.4 Obsolete tests

**Tests that become obsolete:**
- `platform/sql-balance.test.ts` (rewriter removed).
- `scan/repo-secret-binds.test.ts` (packing removed).
- Bind-budget tests and fixtures: `session-activity-authority-{bind,count}-budget.test.ts` and `repo-{action-approval,action-gate-stale,asset-bind}-budget-test-fixtures.ts`. They test packing under the 100-parameter cap; the corpus ≤40 assertion replaces them.
- Split-snapshot refusal tests: `output-authority-split-*.test.ts`, `routes-display-authority-split-*.test.ts` and the `repo-*-split-test-fixtures`. They assert refusal on volatile-column changes, which are now benign. Invert them into liveness tests.
- Undo 404 expectations: `undo-authority-races.test.ts` and the undo-console 404 expectations. Invert them.
- Revision-toggling cases: `repo-act-authority-{release,identity,history,screens,sessions}-cases` toggle `updated_at` revisions. Rewrite them as epoch-specific safety cases.
- Proof and envelope fixtures: `repo-undo-event-*`, `scan-undo-proof*`, `repo-scan-retention-proof-*` and `repo-history-proof-cas.test.ts` (proofs removed).
- Keyset-in-SQL assertions: `passes/credential-keyset-sql.test.ts` and the per-statement keyset assertions. Keep the init tests and the provider-facing helper tests.
- Delivery stale assertions: the `delivery/{binding,transfer-fences}.test.ts` cases that assert `DELIVERY_STALE` on a version bump. Invert them.
- The four `sessions.roles` fixtures listed in §6.1.

### 7.5 Provider track

**Provider track (later, not this release).** Leave these sites on column equality and keep them working:
- **Pass-column fences** (`docs/design/wallet-providers/current-state.md` §5): `wallet-providers/repo-instance-proof.ts:41-109` (`walletInstanceProofSql`), `repo-instance.ts`, `repo-instance-mutations.ts`, `repo-instance-offers.ts`, `repo-offers.ts`, `repo-sync-{queue,targets,retention}.ts`, `repo-instance-retirement-staging.ts`, `repo-status.ts`, `repo-callbacks{,-tombstone,-tombstone-retirement}.ts`, `repo-google-callback.ts`, `repo-accounts.ts`, `repo-account-writes.ts`, `repo-projection{,-write}.ts`, `repo-samsung-verification.ts`.
- **Keyset helpers:** the keyset-commitment helpers listed in §5, and the about 70 files carrying the commitment.
- **Triggers:** the triggers in `0043` and `0050`.
- **Columns they compare stay as they are:** `p.version`, `p.revision`, `p.release_id`, `p.credential_generation` and `p.lifecycle_generation` keep their semantics, and `credentialRefKeysetSql` and `credential-keyset.ts` stay exported.
- **Shared callers:** `repo-credential-transfer-finish.ts`, `repo-ops-retention.ts` and `sandbox/repo.ts` keep calling `providerRetirementCompleteSql` inside their grant checks. It is parameter-free and vacuous while providers are dark.
- **Later adoption:** an instance stores `pass_row_version` plus an account epoch, the proof becomes one equality inside a grant, and the keyset becomes one pin per request.

## Appendix A. Fence-site ownership (generated 2026-11-11)

Paths are relative to `src/worker/modules/` unless they start with `src/`. Wallet-provider files are excluded.

**WP1:**
- `api-keys/repo.ts`
- `orgs/{repo,repo-members,membership-service}.ts`
- `settings/repo.ts`
- `users/repo.ts`
- `passes/{http,repo-authority}.ts`
- `broadcasts/repo.ts`
- `holders/{repo,repo-blocks}.ts`

**WP-T:** `templates/{repo-authority,repo-eligible,repo-imports,repo-release-write,repo-releases,repo-releases-active,repo-source,repo-stale,repo-sync-release,repo-sync,repo-upload}.ts`

**WP2:**
- `passes/{repo-check-in,repo-connection-context,repo-credential-transfer,repo-credential-transfer-fences,repo-credential-transfer-finish,repo-credential-transfer-source,repo-detail-read,repo-history-image,repo-ops,repo-ops-retention,repo-release,repo-remove,repo-transfer-asset-gc,repo-workflow-releases,repo-write,repo-write-authority,repo-write-backfill,repo-write-insert-statement,repo-write-publish,repo-write-publish-snapshot,repo-write-retained,repo}.ts`
- `apple/repo-personalize.ts`
- `passes/repo-credential-keyset.ts` (helper kept; WP2 owns non-provider call sites)

**WP3:**
- `delivery/{repo-issuance-intent-fence,repo-issuance,repo-issued-email,repo-outbox,repo-outbox-enqueue,repo-outbox-refresh}.ts`
- `bundles/repo.ts`
- `sandbox/repo-capture.ts`

**WP4:** `connections/{access,repo,repo-legacy-admission,repo-legacy-inbox,repo-legacy-quarantine,repo-pass-refresh,repo-pass-snapshot,repo-runs,repo-sync,repo-sync-retention,repo-webhook-item-claims,repo-webhook-items,repo-webhook-legacy-unproven,repo-webhook-replay,repo-webhook-resolve,repo-webhook-retention,repo-webhook-retention-dispatch,repo-webhook-retention-stage}.ts`

**WP5a:** `scan/{repo-actor-authority,repo-actor-csrf-authority,repo-actor-event-authority,repo-actor-legacy-authority,repo-actor-scanner-authority,repo-credential-keyset-authority,repo-credential-tombstones,repo-sample-scope-fence,guard}.ts`, plus the new `scan/authority-checks.ts`

**WP5b:**
- `scan/{act-check-in-success,act-held,act-stop,misses,repo-act,repo-act-answer,repo-act-authority,repo-act-choose,repo-act-claim,repo-act-claim-lifecycle,repo-act-effect-assertions,repo-action-authority,repo-admission,repo-asset-grant-statements,repo-gate-bindings,repo-gates,repo-gates-authority,repo-miss-authority,repo-pass-predicates,repo-scan-effect,repo-scans,repo-scans-write,rules,outcome}.ts`
- all other `scan/act*.ts`
- `events/service.ts`
- `src/web/scan/api/to-fail.ts`

**WP6:** `scan/{repo-undo,repo-undo-*,undo*,scan-undo-*}.ts`

**WP7:** `scan/{lookup,repo-lookup,repo-counts,repo-counts-query,repo-feed,repo-feed-console,repo-feed-projection,repo-feed-select,repo-feed-snapshot,repo-history-authority,repo-history-proof-cas,repo-history-proof-fields,repo-history-proof-plan-query,repo-history-proof-read,repo-scan-history,repo-live,repo-live-lifetime,repo-live-photo-delivery,repo-live-recipient,repo-live-template-snapshot,repo-output-predicates,repo-output-authority,repo-routes,repo-routes-display,repo-search,repo-scan-retention,repo-scan-passless,repo-scope-release-predicates,repo-scope-releases,repo-session-read-event,repo-session-read-predicate,repo-session-counts,repo-session-activity,repo-session-activity-fences,session-activity}.ts`

**WP9:** `scan/{repo-device,repo-scanners-pair,pairing,pairing-session,pairing-token,scanners,scanning-devices,scanning-device-revocation,scanning-sessions,repo-scanning-sessions,setups,staff-admin,staff-admin-views,staff-pin,repo-staff-authority,repo-staff-activity,repo-staff-pin-counters,events,events-mutations,repo-event-authority,repo-event-keyset,repo-events,repo-scanner-configuration,repo-scanner-configuration-authority,repo-scanner-configuration-predicate,repo-scanner-configuration-report-guard,scanning-workspace-report,routes-staff-session,repo-session-authority}.ts`

**WP7 (fence) and W1-13 (logic):** `scan/repo-lookup-backfill.ts`. WP7 converts its fence; W1-13 keeps the backfill logic.

## Appendix B. Guarded tables

Raw writes to these tables are banned outside `platform/authority.ts`:
- **Platform:** `orgs`, `settings`, `org_memberships`, `org_invitations`, `api_keys`, `users` (status), `sessions` (revoke).
- **Passes and templates:** `passes`, `pass_assets`, `pass_credential_transfers`, `pass_credential_tombstones`, `pass_issuance_deliveries`, `templates`, `template_candidates`, `template_approvals`, `template_releases`.
- **Delivery:** `outbox`, `bundles`, `bundle_passes`, `captured_emails`, `sandbox_forwards`.
- **Connections:** `connections`, `connection_runs`, `connection_webhook_retention`, `connection_webhook_items`.
- **Scan:** `scans`, `scan_gates`, `scan_presence`, `scan_staff`, `scan_events`, `scan_event_templates`, `scanners`, `scanning_sessions`, `scanning_devices`.
- **Ledger:** `pass_events`.

**Allowlist:**
- `wallet_*` tables (provider track);
- session idle slide and `last_seen_*` updates;
- counters;
- test fixtures.

## Owner answers (2026-11-11)

1. Wave 1 tasks that rewrite the same fences (W1-05, W1-06, W1-07, W1-10, W1-11, W1-18) are built as WP1-WP7 on WP0, not patched first.
2. Queued work (issuance email, scheduled broadcast, import) survives the initiator's sign-out and idle timeout. It stops only on membership or API-key revocation, org suspension, or a pass change such as void or holder transfer.
3. Work queued before a suspension stays cancelled after reactivation.
4. If a release is withdrawn after create, the issuance email still sends the pass that was created. Release checks apply at create and publish only.
5. Cutover window: a temporary Cloudflare WAF rule returns a short maintenance response on the affected admin write routes between migrate and promote. Pass pages, Wallet updates and scanning keep working.
6. Rollback: roll forward only once migrations have run. The Worker-only rollback stays documented as an emergency degraded mode, not a normal option.
7. Threat model: an operator with a D1-edit-only API token is out of scope (R9 accepted). The redundant retention HMAC re-check is dropped and documented.
8. Settings race: a scan racing an org settings save may use the previous settings for that one scan (R8 accepted). No fence, no 409 at the door.
9. Interpretations confirmed by the coordinator under answers 2 and 3: perpetual connection syncs are standing jobs, not queued one-off work, so they pause while an org is suspended and resume after reactivation. Disabling a user counts as revocation: it stops that user's queued work, which stays cancelled if the user is re-enabled, consistent with answer 3.

## WP0 spike results

Run on local D1 (miniflare, `vitest --project worker`). Everything below is covered by a test in `src/worker/platform/authority*.test.ts`.

| Question | Result | Effect |
| --- | --- | --- |
| `recursive_triggers` | `0`. `foreign_keys = 1`, `defer_foreign_keys = 0`. A trigger that updates its own table ran once, not recursively. | The epoch triggers update only the epoch column, so they cannot loop under either setting. |
| Deferred FK at batch commit | **Enforced.** A batch whose final state violates a `DEFERRABLE INITIALLY DEFERRED` FK fails as a whole and rolls back. A batch that violates it midway but ends valid commits. The error is opaque (`internal error; reference=...`, no constraint text). | The sentinel FK is **mandatory** and is in `0052`: `authority_grants.leak_guard` references `authority_grant_leaks`, a table whose insert trigger always aborts. A batch that commits with its grant row present fails. The failure cannot be classified, so treat it as ambiguous (a bug, never a refusal). |
| `RAISE` inside `CASE` | Works in a trigger body (`SELECT CASE NEW.denied WHEN ... RAISE`) and for an `INSERT ... SELECT` whose `denied` column is computed in a `MATERIALIZED` CTE chain. A BEFORE trigger fires before the table's `CHECK`s, so a missing actor reaches `authority_denied:actor`, not a CHECK error. | The grant design works as written. |
| `?NNN` and the 100 limit | The limit is the highest index, not the number of uses: `?1` reused 95 times counts once. `?101` fails (`variable number must be between ?1 and ?100`); 101 anonymous `?` fail. The bind count must equal the highest index exactly (extras fail). | Parameter counting is by distinct index. `authority.ts` uses positional `?` and checks `<= 90` (grant) and `<= 40` (writes) from the bound list. |
| Expression depth | **D1 allows 100, not 1000.** A chain `a+b+...` of 101 terms fails. A flat `OR` chain: 95 terms ok, 98 fail. `EXISTS(... WHERE EXISTS(...))` nesting: 12 ok, 14 fail (about 7 levels each). A flat `MATERIALIZED` CTE chain: 30 ok, 60 fail. A `CASE` with 30 `WHEN`s ok. | The 16-term split of the passes trigger is conservative (41 bump terms would fit in one). Kept as 15/15/11. A hand-written check nested more than 2 `EXISTS` deep inside the grant `CASE` is at risk; keep checks flat. |
| Table and result width | At most 100 columns per table and about 100 per result set (`too many columns`). | `passes` has 61 columns (60 + `row_version`). Room for about 39 more. |
| `EXPLAIN` / compile of the split triggers | All `0052` triggers compile; the passes triggers have 15, 15 and 11 `IS NOT` terms. | None. |
| `RETURNING` and the epoch | Returns the value **before** the AFTER trigger ran (`1`), a later `SELECT` shows `2`. | As designed. |
| **New: `meta.changes` counts trigger changes** | `UPDATE passes SET display_title = ...` reports `meta.changes = 2` (the row plus the `row_version` bump); a volatile-column update reports `1`; `UPDATE orgs SET status` reports `2`. The SQL function `changes()` in the next statement of the batch returns `1`. `RETURNING` returns 1 row. | **Changes later packages.** Any `result.changes === 1` / `meta.changes === 1` after a write to an epoch'd table now sees 2 whenever a bump fires. Packages must count rows with `RETURNING` (the builder's `returning`, or `test/helpers` `runOne` in tests), never `meta.changes`; the grant builder never uses `meta.changes` as an authority signal. Sites to re-check are the `=== 1` / `!== 1` comparisons (about 56 outside tests) whose statement updates a bump-set column of `passes`, `scanners`, `scan_staff`, `scan_events`, `scanning_sessions`, `connections` or `orgs`, or inserts into `settings`, `scanning_devices` or `scan_event_templates`; each owning package re-checks its own. `settings/repo.ts:112` is not affected: its last statement only writes `orgs.updated_at`, a volatile column |
| **New: BEFORE INSERT guards ignore `OR IGNORE` / `ON CONFLICT`** | A guard that raises `ABORT` on an existing key aborts `INSERT OR IGNORE` and `ON CONFLICT DO NOTHING` / `DO UPDATE` too, where plain SQLite would skip or update. | On the guarded Rule-2 and epoch tables an insert that hits an existing key fails with `UNIQUE constraint failed: <table>.<column>` instead of being a no-op. One production statement did this: `ensureOrgStmt` (`orgs/repo.ts`, `ON CONFLICT (slug) DO NOTHING`, run on every template sync); it is now `INSERT ... SELECT ... WHERE NOT EXISTS (slug)`. The `api_keys` bundle fixture got the same rewrite. |

### What WP0 changed against the design

- **Fixed-column guards** (`<table>_fixed_columns`) exist for `orgs`, `passes`, `scanners`, `scan_staff`, `scan_events`, `scanning_sessions` and `connections`. `created_by` may become NULL only when the user row is gone (same exception as `0039`). `scanners.id` keeps `scanners_id_immutable`.
- **`connections.generation`: the bump trigger moves to WP4.** Tests simulate a concurrent edit with a raw `UPDATE connections SET mode = ...` that must leave `generation` alone (`sync.test.ts`, `webhooks.test.ts`: the mode fence is exercised separately from the generation fence). A trigger over `mode`, `config` and the other bump columns changes which fence fires first. So `0052` ships only the monotonic guard, the fixed-column guard and the no-replace guard for `connections`; the app keeps writing `generation` as today. WP4 adds the trigger (`AFTER UPDATE OF <14 bump columns> ON connections WHEN NEW.generation = OLD.generation AND (...)`, the shape of the other epochs; the column list is in `authority-columns.ts`) together with the removal of the explicit bumps and the fence rewrite.
- **`template_release_heads` is a view, not a table.** The design's trigger-maintained table adds a second change to every `template_releases` insert, and production release writes and wallet-provider fixtures check `changes === 1` on that insert (`runtime-integration-fixtures.ts:67` and more). A view over `template_releases` (the row with the newest generation per template, org scope, mode and provider) gives the same `(template_id, org_scope, mode, provider) -> release_id, generation` rows, is always current, cannot be written, replaced or drift, and needs no backfill or guard triggers. WP-T reads it the same way; the view's `COALESCE(org_id,'')` hides `org_id` from the index, so WP-T reads the newest generation straight from `template_releases` (`org_id IS ? ORDER BY generation DESC LIMIT 1`, full `template_releases_head` prefix) and keeps the view for readers that do not need the index. A table can still replace it later if a read needs to join without the subquery.
- **Role names** are validated once at insert for `org_memberships` and `org_invitations` (`..._roles_valid`): a JSON array of distinct, known role names.
- **`authority_grants.leak_guard`** is the sentinel FK column (not in the design's column list).
- **Builder API:** `grant(ctx, input)` returns a `Grant` synchronously (no round trip until `commit()`); the scope comes from the purpose prefix. `g.update`, `g.delete`, `g.insertSelect`, `g.upsert`, `g.joined`, `g.insertJoined`, `g.add(...)`, `g.commit()`, `grantedBatch(db, grants)` (grants with identical `codes`, one transaction), `jobGrant(ctx, input)`. The full contract, including owned columns, the declared edges and the expression set, is in section 1.2. A statement injects the grant's org (and mode, for `org_mode`) with an `EXISTS` on its own grant row. `platform` grants inject nothing, and are the only ones that write `users` and `sessions`.
- **Real statement sizes** (`authority.test.ts`, "statement corpus"): a tenant-session grant with the session, the org revision and five epoch checks binds 23 values (1.76 KB); API key 19 (1.55 KB); scanner 20 (1.57 KB); platform admin 23 (1.75 KB). The §5 estimates of 10-13 cover the bare principal check; each epoch check adds 2 and about 150 bytes. Writes bind 3 for a one-column update. All well inside 90 / 40 / 32 KB.
- **Test helpers for the new guards** (`test/helpers/triggers.ts`; the worker setup restores any dropped trigger after each test):
  - `editSessionAuthority` for tests that rewrite `sessions.roles` / `amr` (27 sites in 19 files, more than the four fixtures in section 6.1; WP1, WP5b and WP9 delete these cases when they convert the fences);
  - `editFixedColumns` for tests that age `passes.created_at` (sandbox purge, 11 sites);
  - `allowInvalidRoleNames` for tests that insert unknown or duplicate role names (`settings`, `audit` and `metrics` tenant-access tests).
- **`meta.changes` assertions:** about 50 test assertions of the form `expect(await run(...)).toEqual({ changes: 1 })` on a statement that now moves an epoch had become `changes >= 1`. The review restored them: tests use `runOne` / `runExactly` (`test/helpers/exact-rows.ts`), which append `RETURNING 1` and assert the exact row count, or a fixed `meta.changes` where the trigger set is deterministic (a `scanning_devices` insert is 2). The tombstone and cascade tests that already failed at the baseline keep their strict form.
- **Daily sweep:** `authority.sweep` (`sweepLeakedGrants`) is a daily cron hook. With the sentinel FK a leaked row cannot commit, so it is a second net.

### WP0 review fixes (2026-11-11)

Answers `.wrangler/agent-logs/wp0-review.md`. `0052` and the amendments were unapplied, so they were amended in place.

| Finding | Fix |
| --- | --- |
| B1 `joined` writes outside the grant | Declared `edges` in `GUARDED_TABLES`; `joined` only for org-less children; parent keys cannot be set; `via` names a declared edge, not a column pair. |
| B2 `settings.scope` unprotected | Owned columns derive from `TableScope.org` and are refused in `set`, `inc`, `where`, `columns`, upsert `update` and check conditions. |
| B3 builder gaps | `insertJoined`, platform writes to `users.status` and `sessions.revoked_at`, `upsert` with a fixed target, `maxNow` / `jsonSet` / `coalesceTo` / `inList` / `gt` / `lt` / `isNotNull`. |
| M1 job brand | The token is private to `job-authority.ts`; `createJobContext(env, kind)` for queue, cron and workflows, `createDetachedContext(env)` for `stores.ts`, the scan hub and the template registry (`createServiceContext` remains as its alias for tests); `check:rules` lints importers. |
| M2 silent no-op | `require: 'one'` and `returning`. |
| M3 reads | `tenantFilter(alias, table, scope)`. |
| M4 multi-grant batches | One grant per batch unless all share `codes` (`GRANT_BATCH_MIXED`); later grants' checks see earlier grants' writes. |
| M5 | `Grant.prepare` is private; `prepareGrantForTest` for tests, linted elsewhere. |
| M6 | `MembershipLiveness`: `via: 'session'` (session hash required) or `via: 'deferred'` (revision required). |
| M7 | `authority-baseline.test.ts` covers pass create, template upload and sync, scan check-in; the `ensureOrgStmt` break is in section 6.2. |
| M8 | `leak_guard NOT NULL` with `CHECK (leak_guard = id)`, so the sentinel key cannot be skipped with NULL. |
| M9 | Non-partial `template_releases_head` index; `releaseHead` check with org-over-platform and baked precedence. |
| Minors 1-3 | Re-keying `scanning_devices.scanner_id`, `settings.scope` / `key` and `scan_event_templates` rows bumps old and new owners; `scanning_devices_no_replace`. |
| Minor 4 | The lint matches `\bOR\s+REPLACE\b` (so `UPDATE OR REPLACE`). |
| Minor 5 | `retired_api_key_ids`, `api_keys_no_id_reuse`. |
| Minor 6 | Connection purposes must be `org_mode` and live: `purpose NOT GLOB '*.connection.*' OR IFNULL(mode, '') = 'live'`. |
| Minors 7-13 | `jobGrant` validates `.job.`; epoch columns derived per table; `rawCheck` is read-only and tenant-column-free; `tenantMatch` throws `AuthorityError`; the two dead lint rules fire (builder call naming `org_id` / `mode`; raw writes to the authority tables); a test ties the `0029` role list to `OrgRoleSchema`; a platform principal that names an org needs it active (section 1.2). |

**Open item (M8): confirm on a remote preview D1.** Local D1 logs `broken.inputGateBroken` for the batch that the sentinel foreign key fails. A preview database should confirm the failure is still an ordinary rejected batch (the rows roll back, the Worker keeps serving) before the first production migration. Agents do not run `--remote`; the owner or the cutover agent does.

### WP-T results (2026-11-11)

**Fences replaced** (head reads now use `template_release_heads`):
- `templates/repo-releases.ts` `getActiveRelease` (was `activeReleaseIdSql`, a `NOT EXISTS newer` subquery) and `getLatestRelease` (was `ORDER BY generation DESC LIMIT 1`).
- `repo-eligible.ts` and the three queries in `repo-stale.ts` (`quietUnqueuedTemplates`, `claimTemplateReissue`, `olderLivePasses`): `effectiveReleaseIdSql` (`repo-release-heads.ts`).
- `repo-sync-release.ts`: generation, `previous_release_id`, the "no release yet", "replace head" and "already current" checks (five head subqueries).
- `repo-release-write.ts` `activateReleaseStmt`: expected generation, expected release id, and the adapter and audience monotonic checks; `updateTemplateAfterReleaseStmt`: `NOT EXISTS newer` became "is a head".
- `repo-sync.ts` `bakedSyncComplete`: head subquery, plus a saved-hash check so a settled isolate resyncs after `0052`.
- `releases-active.ts`: the separate platform-fallback query is gone (the head query has the precedence); the asset byte re-read is replaced by `verifyStoredContent`.
- `platform/authority-checks.ts` `releaseHead`: now reads the view, and applies the same precedence as `effectiveReleaseIdSql`. An org release left by a past assignment no longer shadows the platform head of an unassigned baked template, and the platform head counts only for a baked template with `org_id IS NULL` (it was any baked template).

**Precedence** (`effectiveReleaseIdSql` and `releaseHead` agree): the scope org's head, only for an uploaded template or a baked one assigned to that org; otherwise the platform head of an unassigned baked template. Provenance is then checked on that one row. A legacy release is effective only as the scope's head at the template's active version, so it never outlives the first approved release. Legacy rows are exempt from the saved-hash check.

**Issuance without byte reads.** `verifyStoredContent`: the saved hash equals the release's (in SQL and in JS; a version with none is verified from its bytes once and saved), the content hash recomputed from the stored documents, asset metadata, saved asset sha256 and extras equals it, and each stored object still exists with its declared size (`R2 head`). Publication (`verifyCandidate` with `deep`) hashes the bytes. The pass build trusts the metadata sha1 and crc32, so `registry.openAsset` checks size and sha1 of an R2 asset before the asset cache can keep it (`TEMPLATE_CONTENT_CHANGED`); a same-size substitution is therefore refused when the asset is first opened, not at the issuance fence.

**Still on the old helper** (deprecated `activeReleaseIdSql`, `effectiveReleasePredicateSql`, `activeReleasePredicate`, `activeReleaseBindingPredicate`, `noScopedReleaseSql`): WP2 `passes/repo-release.ts`, `passes/repo-workflow-releases.ts`; WP4 `connections/repo-pass-snapshot.ts`, `repo-webhook-replay.ts`, `repo-webhook-item-claims.ts`; scan files `repo-actor-legacy-authority`, `repo-counts`, `repo-feed-select`, `repo-feed-snapshot`, `repo-history-proof-cas`, `repo-history-proof-read`, `repo-live-template-snapshot`, `repo-lookup`, `repo-pass-predicates`, `repo-scope-release-predicates`, `repo-scope-releases`, `repo-search` (WP5a, WP5b, WP7) and their test fixtures; and wallet-providers `repo-projection.ts`.

### WP1 results (2026-11-11)

Tenant authority and W1-10. Fences replaced:

| Site | Old | New |
| --- | --- | --- |
| `passes/repo-authority.ts` `tenantPassAuthoritySql` / `Params` (same signatures) | `o.updated_at = ?`, `s.amr`, `json(s.roles)`, `json(m.roles)`, role validation and distinct count, `json(k.scopes)` | `o.access_revision = ?`; membership, user, org, session or key live; capability and scope still derived from the row's own roles and scopes. 13 binds became 9 (session), 9 became 8 (key) |
| `settings/repo.ts` `writeScope` | `o.updated_at = ?` on every statement, last `UPDATE orgs` with `changes() === 1`, 403 | grant `org.settings.update` with `epochIs(orgs.config_revision)`: stale is 409 `SETTINGS_CHANGED`. Platform scope: `platform.settings.update` (live admin session). A save no longer touches `orgs.updated_at` |
| `orgs/repo-org-writes.ts` `updateOrgRow`, `saveOrgBranding` | `writeAuthority` plus `updated_at` | grant `org.org.update` plus `config_revision` CAS (409); platform path is CAS only |
| `api-keys/repo.ts` | `mutationAuthority`, `NOT EXISTS json_each` scopes, `changes() = 1` audit | grants `org_mode.api_key.create`, `platform.api_key.create`, `*.api_key.revoke`; each scope checked against the creator's own roles; audit row in the same batch (`audit/repo-granted.ts`) |
| `orgs/repo-members.ts` writes | manager SQL, `? = 1` admin bypass, `changes()` audit, `isLastOrgAdmin` after the fact | grants `org.member.invite`, `uninvite`, `revoke`; last org_admin is a grant check (409 `LAST_ORG_ADMIN`); principal is a live admin session or a member with `members:manage` |
| `users/repo.ts` `setStatus` | `changes() = 1` chain | `platform.user.disable` / `enable` grant (`setStatusAsAdmin`); disabling cancels the user's scheduled broadcasts, and so does re-enabling |
| `orgs/repo.ts` `setOrgStatus`, `markOrgDeleted` | none | suspend or delete cancels the org's scheduled broadcasts in the same batch; they stay cancelled on reactivation |

`TenantPassWrite.orgUpdatedAt` and `tenantOrgUpdatedAt` keep their names but carry `access_revision`; WP8 renames them.

Left for other packages: threading the admin session into `orgs/service.ts` (create, status, delete) and `users` trusted callers; `settings` system-scope writes (`writeSystemValue`, jobs); invitation accept; `broadcasts` is not in Appendix B, so its writes stay raw behind the drop-in; `pass_issuance_deliveries` and import work need their own cancel on user disable (WP3, WP-T); `passes/repo-credential-transfer-source.ts` still compares `o.updated_at` and `o.branding`, so a branding save fails a holder reassign (WP2). Grant batches cannot carry an audit row through the public API: `audit/repo-granted.ts` builds a `GrantedStatement` directly, and a `Grant.audit()` would replace it.

**WP-T review fixes.**
- Asset bytes: `registry.openAsset` verifies size and sha1 for R2 assets on every open, so a bad swap is never cached by the pass build.
- `createCandidate` (now `releases-create.ts`) writes the hash row only if its candidate row was inserted in the same batch.
- `releaseHead` also requires an active template and uploaded-template ownership; callers take the release id from `effectiveReleaseIdSql` / `activeRelease` in the same request (legacy `active_version`, policy and hash rules live there). Head lookups read `template_releases` directly; `olderLivePasses` computes the effective release once per scope.
- `bakedSyncComplete` requires the system head's `content_hash` to equal the saved hash.
- `READ_PATH_WRITE_ALLOWLIST` (`repo-version-hashes.ts`) lists `template_version_hashes`: the first issuance of a pre-hash release writes its write-once row on a read; WP7's "GET issues no writes" corpus test imports it.
- Open, WP2: the three approved-reissue legacy no-op race tests (`passes/publish-service-release.ts`).
