# Authority epochs and grant rows

Replaces column-equality fences with trigger-maintained epochs plus one authority grant row per batch. Built in migrations `0029` to `0065` (`0052` carries the epochs and the grant table). The code is the reference: `src/worker/platform/authority*.ts`, `tools/authority-scope.ts`.

- **Wallet providers** ship dark and keep their column-equality fences (section 7.3).

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

The classification test (`authority-columns.test.ts`) reads `PRAGMA table_info` and requires each column in exactly one class. With two epochs on one table, the two bump sets must be disjoint and every column must sit in one bump set, volatile or fixed.

| Epoch | Bump set | Volatile | Fixed | On mismatch |
| --- | --- | --- | --- | --- |
| `orgs.access_revision` (`0029`) | `status` | | `id`, `created_at` | 403 `ORG_ACCESS_CHANGED` |
| `orgs.config_revision` (`0052`) | `name`, `slug`, `branding`, `default_identity_id`; settings rows with scope `'org:'\|\|id` (insert, update, delete; a row moved to another scope or key bumps both orgs) | `updated_at`, `branding_dirty_at` | | 409 `SETTINGS_CHANGED` (edit CAS only) |
| `passes.row_version` (`0052`) | everything not volatile or fixed. `scan_code`, `barcode_hash` and `lookup_hash` bump only when `OLD.x IS NOT NULL` (minor 5) | `next_sync_at`, `last_synced_at`, `sync_error_code`, `sync_failures`, `refresh_requested_at`, `last_refreshed_at`, `modified_collision`, `pending_cause`, `pending_actor_type`, `pending_actor_id`, `pending_pass_json`, `pending_source`, `object_sha256`, `object_size`, `content_hash`, `download_token_rotated_at` | `id`, `created_at`, `created_by` | 409 `PASS_CHANGED` (derived writes) |
| `passes.credential_generation`, `lifecycle_generation`, `link_generation` | unchanged (`0030`, `0042`) | | | `authority_denied:lineage` |
| `scanners.credential_epoch` (`0052`) | `token_hash`, `token_prefix`, `csrf_secret`, `revoked_at`, `expires_at`, `org_id`, `mode`, `kind`, `pair_code_hash`, `paired_at` | | `id`, `created_at`, `created_by` | 401 `SCANNER_REPAIR`, the only refusal that unpairs, only when the credential is lost (`scannerCredentialLost`): token replaced (hash or prefix), revoked, expired or idle, kind moved across the terminal boundary, or CSRF secret rotated. Any other move (a pair code issued, a mode move, a display/device switch) is 409 `SCAN_CONFIG_CHANGED` |
| `scanners.config_epoch` (`0052`) | `device_role`, `event_id`, `settings`, `time_zone`; changes to `scanning_devices` other than `capabilities` and `reported_at` (a re-keyed `scanner_id` bumps both scanners) | `name`, `last_seen_at`, `last_ip_prefix`, `paired_label`, `pair_expires_at`, `pair_created_by`, `staff_id`, `staff_since`, `staff_seen_at`, `updated_at` | | 409 `SCAN_CONFIG_CHANGED` |
| `scan_staff.auth_epoch` (`0052`) | `role`, `pin_hash`, `pin_set_at`, `disabled_at`, `org_id` | `name`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_STAFF_CHANGED` |
| `scan_events.config_epoch` (`0052`) | `match_input`, `match_values`, `opens_at`, `closes_at`, `time_zone`, `capacity`, `reentry`, `archived_at`, `org_id`, `mode`; insert, update (both events) and delete of `scan_event_templates` | `name`, `note`, `expected`, `expected_at`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_CONFIG_CHANGED` |
| `scanning_sessions.config_epoch` (`0052`) | `status`, `accepts`, `settings`, `time_zone`, `org_id`, `mode`; insert, update and delete of `scanning_session_zones` (`0073`) | `name`, `updated_at` | `id`, `created_at`, `created_by` | 409 `SCAN_CONFIG_CHANGED` |
| `connections.generation`, bumped by `connections_generation_bump` (`0044`); `0052` adds the monotonic, fixed-column and no-replace guards. | `enabled`, `mode`, `org_id`, `connector_type`, `connector_version`, `config`, `credential_id`, `webhook_credential_id`, `mapping`, `default_template_id`, `holder_email_field`, `auto_create`, `auto_email`, `on_missing` | all other columns | `id`, `created_at` | `STALE_GENERATION` |
| `users.access_revision` (`0052`) | `status` | | | Deferred work captures it; a disable then enable cannot revive work queued before. 403 `ACTOR_CHANGED` |
| `template_release_heads` (`0052`): a **view** of the newest `template_releases` row per `(template_id, org_scope, mode, provider)`; `org_scope` is `''` for the platform | none: it is derived, so it cannot be written, replaced or drift. A table would add a trigger change to every release insert, and D1 counts those in `meta.changes` | | | 409 `TEMPLATE_RELEASE_CHANGED` (create and publish only) |

**Head lookup precedence** (`effectiveReleaseIdSql` and `releaseHead` agree): the scope org's head, only for an uploaded template or a baked one assigned to that org; otherwise the platform head (`org_scope = ''`) of an unassigned baked template. A legacy release is effective only as the scope's head at the template's active version, so it never outlives the first approved release. The view's `COALESCE(org_id,'')` hides `org_id` from the index, so `releaseHead` reads `template_releases` directly (index `template_releases_head`).

**Rows checked by value, with no epoch:**
- **Sessions:** `revoked_at IS NULL AND expires_at > now AND idle_expires_at > now`.
- **Memberships:** `id = ? AND revoked_at IS NULL`.
- **API keys:** `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`.
- **Users:** `status = 'active'`.
- **Templates:** `status = 'active' AND (org_id = g.org_id OR org_id IS NULL)`.

**`updated_at` columns become timestamps.** `orgs`, `templates`, `scanners`, `scan_staff` and `scan_events` keep `updated_at` only as a timestamp. `tools/authority-scope.ts --strict` (part of `check:rules`) fails `updated_at = ?` in worker SQL.

**`scanning_config_revisions` (`0024`):** dropped by `0070`. `config_epoch` replaced it.

**Trigger shape.** The passes bump set has about 45 columns. To bound expression depth, it is split into three triggers by column group (`passes_row_version_a`, `_b`, `_c`), because D1 allows expression depth 100.

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
- **Loop safety:** the inner UPDATE touches only the epoch, so the triggers cannot loop. D1 runs with `recursive_triggers = 0`.
- **RETURNING:** returns the epoch from before the AFTER triggers ran. Read the new value with a SELECT later in the same batch.
- **`meta.changes` counts trigger changes.** An `UPDATE` that fires a bump reports 2. Count rows with `RETURNING` (the builder's `returning`; `runOne` / `runExactly` in tests), never `meta.changes`.
- **BEFORE INSERT guards ignore `OR IGNORE` and `ON CONFLICT`.** On guarded tables an insert that hits an existing key fails with `UNIQUE constraint failed`; use `INSERT ... SELECT ... WHERE NOT EXISTS`.

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
  WHEN 'staff' THEN RAISE(ABORT,'authority_denied:staff')
  WHEN 'config' THEN RAISE(ABORT,'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT,'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT,'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT,'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT,'authority_denied:retention') ELSE RAISE(ABORT,'authority_denied:other') END; END;
CREATE TRIGGER authority_grants_immutable BEFORE UPDATE ON authority_grants
BEGIN SELECT RAISE(ABORT,'authority grant is immutable'); END;
```

Abridged: `0052` also restricts the holder purposes to a `holder` principal. `leak_guard` is mandatory: D1 enforces the deferred foreign key at batch commit, so a batch that commits with its grant row present fails. The failure message is opaque (`internal error`), so treat it as ambiguous, never as a refusal.

**Scope by purpose:**
- `org_mode`: pass, scan, delivery, connection and bundle writes.
- `org`: settings, org profile, memberships, invitations, org-bound API keys, template authoring and release approval.
- `platform`: org create, status and delete; `platform.org.personal` (an admin's own personal org: org, `standard` entitlements, accepted invitation and `org_admin` membership, insert-only; children only after the grant's own `orgs` insert, the membership only for that grant's invitation, every row for the principal's user id; an active standard org); `platform.org.create_admin` (org create with the creator joined: the same rows and rules, but a non-personal org of any preset but developer); template reassignment between orgs; null-org API keys; platform settings.
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

- **A key acting as a terminal.** A `scans:write` key has no principal of its own in a scan grant: the grant's principal is the `scanner` it was bound to (`api_key_terminals`, written when the key is minted), with its credential epoch. The key is extra checks, in every scan write grant and read fence: the `api_keys` row of the grant's org and mode is live (not revoked or expired), lists `scans:write`, is bound to that terminal, and the org's `access_revision` is the one captured when the key was admitted. Refused as `actor` (401 `INVALID_API_KEY`) or `org` (403 `ORG_ACCESS_CHANGED`). Org-bound keys only; the actor stays `s:<terminalId>`, and `scans.api_key_id` records the key.
- **Principals.** A membership is `via: 'session'` (a synchronous request: `sessionIdHash` is required and must be live) or `via: 'deferred'` (queued work: the captured `orgAccessRevision` is required, no session is checked, Rule 4). There is no third form. A `platform` or `system` principal that names an org (`orgId`) acts on it only while the org is active. A holder acts only while its pass's org is active, except a session holder with `unlink: true` (`holder_remove`, built only by `unlinkOwner`): an owner can take a pass off their account in a suspended or deleted org, which unlinks it as it is (`holders/service-remove.ts`). The transfer grants of the same holder (START, FINISH) need an active org; `pass_credential_transfer_insert_guard` also refuses a re-sign there.
- **No raw statements leak.** Statements are opaque values that only that grant can commit. They are not `D1PreparedStatement`s until `commit()` runs, so they cannot run outside their batch. `Grant.prepare` is module-private; `prepareGrantForTest` exists for tests, and the lint rejects it elsewhere. The `GrantedStatement` constructor is token-gated (the lint flags `new GrantedStatement`). Two escape hatches stay inside the grant: `Grant.audit(entry, when?)` appends an `audit_log` row (append-only table; `when` is evaluated at its batch position), and `Grant.unguarded(sql, params)` runs SQL on unguarded tables only.
- **Cross-grant mixing throws** `GRANT_FOREIGN_STATEMENT`.
- **One grant per batch.**
  - Choose one. Several grants may share a batch (`grantedBatch`) only when their `codes` are identical, else `GRANT_BATCH_MIXED`: a refusal is translated with the codes of the grants together, not of the one that failed.
  - They run in order: grant B's checks see grant A's writes, because B's insert comes after A's statements.
- **The builder owns the tenant and the epochs.**
  - **Owned columns** come from `TableScope.org`: `org_id`, `scope` (settings) and `id` (orgs), plus the mode column for an `org_mode` grant. A non-platform write cannot name them in `set`, `inc`, `where`, `columns`, an upsert `update`, or a check's conditions (`GRANT_SCOPE_OVERRIDE`).
  - **Epoch columns** are derived per table from `EPOCH_TABLES` and cannot be set, incremented or inserted.
  - Orgs: `where` may be empty (the grant pins the row) and an org grant cannot create one.
- **Org-less children.** `GUARDED_TABLES` declares each child's foreign-key `edges` (`scan_event_templates.event_id -> scan_events.id`; `bundle_passes` has two). `joined` (update or delete) goes through one edge (`via`, default the first) and the parent supplies the tenant; `insertJoined` selects every parent key from the parent rows, which must all be in the tenant, so a cross-tenant link inserts nothing. A parent key cannot be set, so a child cannot be re-parented. `joined` on a table with its own org column is `GRANT_NO_EDGE`. A test checks every edge against `PRAGMA foreign_key_list`.
- **Platform tables.** `users` (`status`) and `sessions` (`revoked_at`) are written only by a `platform` grant, only those columns, and are never deleted through a grant.
- **Upsert.** The conflict target is fixed per table in `GUARDED_TABLES` (settings: `(scope, key)`); the caller lists the columns to update from `excluded`, never the target, tenant or epoch columns.
- **Expressions.** Values in `set` and `where` are literals or one of `maxNow(now)` (`MAX(col + 1, ?)`), `jsonSet(path, value)`, `coalesceTo(value)`, and in `where` `inList`, `gt`, `lt`, `isNotNull`. Fixed text, bound values; the JSON path is validated. Numbers bind as REAL, so `jsonSet` of a number stores `2.0`.
- **Counting rows.** `require: 'one'` on `update`, `delete` and `joined` adds a lineage check to the grant (exactly one matching row in the tenant, or `authority_denied:lineage`). It sees the state before the batch's writes, so it cannot require a row an earlier statement of the same batch creates. `returning: [...]` returns the changed rows; count them there, never from `meta.changes`.
- **Checks.** `rowIs`, `passRow`, `epochIs` and `exactlyOne` are tenant-scoped through the actor row. `releaseHead(templateId, mode, provider, releaseId, use)` holds when the release is the newest generation for the org, else (for a `baked` template only) for the platform; under `org_mode` the mode must be the grant's. `use` follows the issued-release rule: `issue` (the default, new issuance) needs an active template, `existing` (a pass or scope that already holds the template, such as an event's kept templates) accepts an archived one; a deleted template refuses both. `rawCheck` is read-only SQL that may not mention `org_id`, `mode` or `scope` (use `a.org_id` and `a.mode` for the actor).
- **Reads.** `tenantFilter(alias, table, scope)` emits the org (and mode) predicate against `actor_ok`; use it in every read that joins `authorityPredicate`.
- **No post-batch hooks.** Hooks such as `w.commit?.()` (`passes/repo-write-publish.ts:139`) must return grant statements for the same batch.
- **Reads after the release.** `commitWith(reads)` takes only `afterRead` values (`platform/authority-after.ts`): fixed read-only SQL, checked when built, run after the release in the same transaction so they see the grant's writes. A write that must commit with the grant is a part (`include(writePart(...))` with `{grant}`); decoration that may fail on its own (a scan's PIN refund and photo grant) runs in one batch after the commit and logs `SCAN_FINISH_DEGRADED`, so it never rolls back the scan.
- **`system:` grants** come only from `jobGrant(ctx)`, and the purpose must contain `.job.` (`GRANT_BAD_PURPOSE`; the CHECK is the second net). `ctx` must be built by `createJobContext(env, kind)` for queue, cron or workflow; it carries a branded `JobAuthority` whose token is private to `job-authority.ts`. `createDetachedContext(env)` (stores, the scan hub, the template registry) has no brand, and so does a route's `ServiceContext`. `check:rules` fails any importer of `job-authority.ts` other than `service-context.ts` and `authority.ts`, and any `createJobContext` outside `jobs/` and `workflows/`.
- **`check:rules`** (`tools/authority-scope.ts --strict`, blocking):
  - no INSERT, UPDATE or DELETE on a guarded table (Appendix B) through `stmt`, `run`, `batch` or `db.prepare` outside `platform/authority.ts`;
  - no `OR REPLACE` / `REPLACE INTO` outside the explicit allowlist in §1.3 (it names `push_results` at `delivery/repo-devices.ts:142`);
  - no `updated_at = ?`.
  - The allowlist covers wallet providers, migrations helpers and test fixtures.

**Deny precedence and mapping** (`DENY_REASONS`, `authorityDenied` in `platform/errors.ts`; a purpose may override the code):

| Reason | HTTP and code |
| --- | --- |
| `org` | 403 `ORG_ACCESS_CHANGED` |
| `actor` | 403 `ACTOR_CHANGED`; a scanner: 401 `SCANNER_REPAIR` |
| `staff` | 409 `SCAN_STAFF_CHANGED` (a bound staff member changed; the device stays paired) |
| `config` | 409 `SCAN_CONFIG_CHANGED` |
| `lineage` | 409 `LINEAGE_CHANGED` |
| `release` | 409 `TEMPLATE_RELEASE_CHANGED` |
| `retention` | 409 `RETENTION_CHANGED` |
| `stale` | 409 `STALE` |
| anything else | 403 `AUTHORITY_DENIED` |

The 401 for a scanner applies only when its credential is lost (`scannerCredentialLost`, the `credential_epoch` row in section 1.1).

**Why no usable stale grant can exist:**
1. A D1 batch is one transaction on a single-writer database. No other write runs between statement 1 and the last statement, so the check holds for the whole batch.
2. The grant is inserted and deleted in the same transaction, so no other transaction ever sees it. A crash, a thrown error or a lost connection rolls back the grant together with every write.
3. A failed check aborts at the insert, which rolls back the whole batch. There is no path where the grant is missing and later statements no-op into a half-commit.
4. If a builder bug ever kept a row, its id is a 128-bit token that no later code path sends again (`grant()` mints the id per call).
   - Detection: a global worker-test `afterEach` asserts the table is empty, and the daily `authority.sweep` cron hook (`sweepLeakedGrants`) deletes leftover rows and logs `AUTHORITY_GRANT_LEAK` at `error`.
   - Hard stop: a deferred foreign key to an always-empty sentinel table (`authority_grant_leaks`) makes such a batch fail at commit.
5. Captured epochs are read on the primary. If D1 read replication is ever enabled, capture reads must use the session bookmark. A replica read is never a safety hole (the grant runs on the primary); it only produces spurious `stale` refusals.

**Lost response.** Pass create and the issuance email accept `Idempotency-Key`. A stale write without a key returns 409 and the client refetches; the server does not compare the row with the requested post-state.

**`/api/v1`.**
- `If-Match: <version>` with 412 stays: the client-visible CAS is `passes.version`.
- `row_version` is captured by the server during the same request, never sent by clients.

### 1.2.1 Request-context deferred principals

`via: 'deferred'` is built in a queue, cron or workflow context. A request context may build one only with `allowRequestContext: true`, which is reviewed per site. Each site pins `userAccessRevision` and `orgAccessRevision` captured when the work was captured (a missing user revision is `0`, which never matches), checks no session, and is refused with 403 `ACTOR_CHANGED` when the membership is revoked or the user revision moved, and 403 `ORG_ACCESS_CHANGED` when the org revision moved, like every other principal.

| Site | Verdict | Why |
| --- | --- | --- |
| `modules/templates/repo-grants.ts` (import persist) | Removed | The workflow runs on `createJobContext`; the flag was only a test convenience. The import fixture now uses a job context. |
| `modules/sandbox/repo-forward.ts` `finishForward` | Kept | The request has already sent the mail; the outcome must be recorded in that request even if the owner signed out meanwhile. A job would leave the reservation `sending` until its lease expires. The user revision is read before the send, the org revision is the request's `orgUpdatedAt`. A refusal is logged and the reservation expires with its lease. |
| `modules/delivery/delivery-actor.ts` `deliveryGrant` | Kept | The issuance resume on the creating request acts for the authority stored in the durable intent (the same member, after sign-out or on replay), with the revisions captured when the intent was written. The same intent is resumed by the sweeper under a job context. |


### 1.3 REPLACE and UPSERT guards (M2)

Tables under Rule 2 get BEFORE INSERT guards. Each aborts when a row with the same primary key or any unique key exists, matching the existing `0042:220` and `0047:36` pattern:

| Table | Migration |
| --- | --- |
| `org_memberships`, `org_invitations` | `0029` (role names are validated once at insert: a JSON array of distinct, known roles) |
| `api_keys` | `0039` |
| `api_key_terminals` (edges `key_id`, `scanner_id`) | `0075`: written once with its `scans:write` key by `createKey`; update and delete abort, and an insert for a used or revoked key aborts |
| `template_releases` | `0031` |
| `scan_staff`, `scan_events`, `scanning_sessions`, `scanning_devices` (`scanner_id` is the key) | `0052` |
| `api_keys` ids after delete | `0052`: `retired_api_key_ids` records every deleted id and `api_keys_no_id_reuse` aborts a re-insert, so a deleted key's id is never issued again (D1 counts the retire row in a delete's `meta.changes`) |
| `template_versions` | none new: `template_versions_insert_immutable` (`0049`) aborts on an existing `(template_id, version)` or tombstone, so REPLACE cannot recreate a version |
| `sessions` | none new: `sessions_no_replace` (`0047:36`) |
| `credential_ref_keyset` | none new: `credential_ref_keyset_insert_guard` (`0042:453`) aborts when any keyset row exists, plus `credential_ref_keyset_no_update` and `credential_ref_keyset_no_delete` |

- **REPLACE allowlist (`check:rules`, §1.2):** every `OR REPLACE` / `REPLACE INTO` outside it fails.
  - `INSERT OR REPLACE INTO push_results` in `src/worker/modules/delivery/repo-devices.ts:142`. Safe: `push_results` is not a guarded or Rule-2 table, the row is a per-outbox result keyed `(outbox_id, device_id)` that holds no authority, and the statement is fenced by `pushFenceSql` and the registration check.
  - Wallet providers, migration helpers and test fixtures (§1.2).
  - Anything else needs a reviewed entry here, with the reason it is safe.
- **UPSERT:** `ON CONFLICT DO UPDATE` reaches the update guards, which already reject identity changes. Tests cover UPSERT on every Rule-2 table anyway.
- **Tests:**
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

**What GET handlers may write (corpus test):** only these allowlisted side effects:
- session idle slide (`auth/repo-sessions.ts:75`);
- scanner `last_seen_*`;
- rate-limit counters;
- idempotent cache fills, listed by name;
- the export audit (`org_mode.scan.export` grant, `GET /scans/export` only): one audit row, committed last before the stream.

## 2. Fence family mapping

**Legend for the columns below:**
- **Durable:** re-checked against current rows in the grant.
- **Epoch:** compared through one epoch.
- **JS-once:** checked once at request start because the input is immutable.
- **Dropped:** removed. Every drop is justified in the row.

| Family | Durable | Epoch | JS-once | Dropped, and why |
| --- | --- | --- | --- | --- |
| F1 Tenant session and API-key authority | org active; membership id not revoked; user active; session live (synchronous requests only); key not revoked or expired; target `org_id`/`mode` = grant | `access_revision` | capability from membership roles or key scopes; session roles and amr | `o.updated_at`: settings and branding bump it (`settings/repo.ts`), it is not authority. `json(s.roles)`, `json(m.roles)` and the `json_each` role validation: immutable. |
| F2 Platform admin | session live; user active | | admin role (session roles immutable) | `? = 1` bypass, replaced by the session check (W1-15) |
| F3 Pass snapshot equality | id, org, mode; `lifecycle_generation`; `credential_generation`; `link_generation` where a link is disclosed; no pending transfer; `test_data_quarantined=0` for delivery | `row_version`, for derived writes only: publish, edit, image, member photo, removal claim, transfer, connection apply and refresh, bulk | | **Pass content and credential columns:** version, revision, personalization, image_generation, template_version and release_id. Content changes are not authority, and derived writers catch them through `row_version`. Holder email, owner, serial, auth token, scan code, barcode hash, download token and object key rotate only together with a credential or link generation (`0042:257` reservation trigger), except `barcode_hash` and `lookup_hash`, which a publish can rewrite (the scan grant compares the scanned hash directly; see the revision 2 changes below). `connection_id` is covered by `row_version`. **Snapshot re-reads:** the post-commit re-read compare (`create-row.ts`) and `me` `sameSnapshot` are reads, not authority (W1-16). |
| F4 Evaluated policy | `t.status`, `t.org_id` direct; event match evaluated on the current pass row | release head (create and publish only) | keyset commitment | **Revision stamps:** `o.updated_at` (F1) and `t.updated_at` (a stamp). **Display-only state:** the wallet snapshot (pass JSON hash, identity revision, wallet version, personalization hash). **At scan commit:** the release head, because a newer release does not invalidate a ticket. **Tombstones at commit:** a matching `credential_generation` implies none, because the tombstone insert guard requires the generation to advance (`0042:398-410`). Tombstones stay at resolve time. |
| F5 Scan actor | org; admin per F1 plus session; scanner `revoked_at IS NULL`; `sc.staff_id = ?` bound staff; staff `disabled_at IS NULL`; scanning session `status='active'`; event `archived_at IS NULL`; scanned pass's template in `scan_event_templates` | `credential_epoch`, `config_epoch`, `auth_epoch`, event and session `config_epoch` | CSRF proof, verified against secrets that cannot change without a credential epoch bump (scanners) or at all (sessions, `0047`) | **Per-template release proofs for every scoped template:** only the scanned pass's template matters (W1-18). **Equality on 11 event columns and the `updated_at` revisions:** replaced by epochs. **CSRF proofs in SQL and in ledger rows:** checked in JS; the ledger copy was a leak (W1-05). |
| F6 Override ledger authority | immutable heads-up facts: scan id, org, mode, pass, action, scope, `actor_key`, outcome `heads_up`, `at` within the window, `scans_override_once`; current actor (F5); manager approval: staff role manager, not disabled | approver `auth_epoch` | approver PIN check (at request) | Historical org, template, scanner, session, event and staff revisions and CSRF proofs being equal to current ones. Authority is the current actor's, not a replay of the past one. |
| F7 Undo | target scan: id, org, mode, `state='done'`, `outcome='ok'`, kind, `undone_by IS NULL`; gate CAS `last_scan_id=target AND last_at=target.at`; presence CAS; not in `scan_quarantine_exclusions`; actor F5 with the undo capability; approval when policy requires | actor epochs only | | **Pass and template drift:** pass version and revision, template and release, wallet, identity and the org and template revisions (W1-06). **Proof machinery:** the signed undo envelope, the JSON tokenizer, retention HMAC re-proof and the post-commit `answer()` fence. **Replay:** checks only the idempotency row. **Superseded undo:** a gate CAS miss with `last_scan_id ≠ target` returns 409 `UNDO_SUPERSEDED`. |
| F8 Output and disclosure | actor F5; pass lifecycle and credential generation; photo policy from the current row | | | `modified_at`, `refresh_requested_at`, `last_refreshed_at`, `sync_error_code`, `content_hash`, object sha256 and size, the `field_sources` json_tree, revision, `image_generation`, download token and object key. These are sync metadata (scan-write-2). The silent `'0'` fallbacks go away because statements are now bounded. |
| F9 Retention | row flags (`excluded=0`, `invalidated=0`), quarantine exclusion and pass existence, read directly; purge uses a `system:` grant | | | Per-statement HMAC re-verification of server-held rows. Insert triggers already guarantee integrity once. Anyone able to forge rows can also run the Worker, so the HMAC protects against no actor in scope. W3-02 decides which proof tables to drop. |
| F10 Credential keyset | | | commitment pinned once per request (`requireCredentialRefKeyset`) | Inline SQL in non-provider modules: the row is immutable (`0042:491-494`). The helper stays exported for wallet providers. |
| F11 Connections: context, runs, item claims | connection id and org; `enabled=1`; org access; pass bound to (`connection_id`, `external_ref`); lifecycle and credential generation; no pending transfer; retention row state | `connections.generation`; `passes.row_version`; release head (admit and create) | keyset | **Pass snapshot and keyset:** the 23-value pass snapshot, the retained binding triple and the keyset SQL. **Legacy proof columns:** the 12 `legacy_*` columns become `legacy_pass_row_version`. **JS rechecks:** the repeated `fenced()` rechecks (`records.ts`) are dropped; there is one grant per write batch. |
| F12 Delivery binding, P1-1 | recipient = `p.holder_email`; owner; credential, lifecycle and link generation; `status='active'`, not removed or quarantined; no pending transfer; org access | `access_revision` | | Version, revision, object key, download-token hash and release. The send attaches the current artifact (the claiming UPDATE returns `object_key`). A content refresh no longer cancels mail; this was P1-1's listed side effect. |
| F13 Issuance intent | lineage: intent pass, org, mode, identity, lifecycle generation, recipient, and either the source credential generation or a completed transfer whose `target_generation = p.credential_generation`; principal membership not revoked and user active, or key not revoked | org `access_revision` captured at intent | capability | **Session liveness:** the creator's session, idle expiry, `o.updated_at` and the roles JSON (W1-07). **Unreachable check:** the sample scanner scope (delivery finding 11). **Snapshot and secrets:** the version, revision, serial, auth token, download token and object key snapshot. The stored secrets are removed. **Release at output:** a created pass may be sent. The release is checked at create. |
| F14 Bundles | bundle token; each member row still present in `bundle_passes`, checked once when the stream opens (transfer START deletes it) | | | **NOT NULL error-text matching:** the grant's RAISE reasons replace it. **Per-chunk re-fence:** dropped; responses are immutable-cached anyway (delivery finding). |
| F15 Releases | release id (immutable row); template status and org | head table | adapter revision and capabilities constants | Re-proof of the candidate and approval join on every read. The `template_releases_insert` trigger (`0031:92`) enforces it once, and rows are immutable. |
| F16 Settings and org edits | F1 | `config_revision` (CAS, 409) | | Bumping `updated_at` as an authority epoch |
| F17 Sandbox capture | org, mode, membership; for forwarding only: pass lifecycle and credential generation; `PROVIDER_RETIREMENT_COMPLETE` unchanged | | | Snapshot fence on visibility |
| F18 Display history, asset grants, live hub | actor F5 when fetched | | asset grant = stateless HMAC token (purpose, pass, generation, expiry) | Per-row history proof CAS statements (`scan-display-history.ts`) |

**Revision 2 changes to the table:**

**F3 pass snapshot (minor 4).** A publish rewrites `barcode_hash` and `lookup_hash` with only a version bump (`passes/repo-write-publish.ts`), so "credentials rotate only with a generation" is false for those two columns. The scan grant therefore also compares the scanned credential directly against the current row: `p.barcode_hash = ?`, `p.lookup_hash = ?` or `p.scan_code = ?` (one, by input kind). A ticket whose code was replaced by a publish is refused with `lineage`.

**F5 scan actor (minor 7).**
- Add `sc.expires_at IS NULL OR sc.expires_at > now`.
- `guard.ts` reads `credential_epoch` in the same row read that verifies `token_hash` and the CSRF secret.

**F5 / F10 and the staff PIN reset.** Under Rules 2 and 5 the session CSRF secret (`0047`) and the credential keyset (an immutable singleton) are checked once in JS, at the request (`scan/staff-admin.ts`). The reset is a grant with membership, session, `auth_epoch` and org checks. SQL copies of those two checks would re-check values that cannot change under the request.

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
- **Load-bearing for P1-1:** the transfer START batch runs `DELETE FROM bundle_passes WHERE pass_id = ?` (`passes/repo-credential-transfer.ts`).
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
- API-key scope delegation: `delegableScopes` in JS against the creator's immutable membership roles, and the grant binds the creator's membership id. 
- Broadcast creator: membership not revoked, with `messages:manage` derived from immutable roles.
- Platform-admin `AdminFence`: the F2 grant check.
- Last-org_admin protection: a grant CTE counting other active `org_admin` memberships, evaluated in the same transaction.
- Invitation compensation: unchanged.
- OIDC mail proof: unchanged.
- Staff PIN reset: see F5/F10 above.

**Events API (M6).** `toEventDto` strips `authority`, `*Proof`, `*Csrf*` and keyset fields from every row, old rows included. A test covers it.

**More residual risks** (in addition to R1-R7 above):
- **R8.** Settings policy is not fenced at commit (above). Accepted (owner answer 8).
- **R9.** Retention HMAC re-verification is dropped and documented. An operator holding a D1-edit-only API token is out of scope; that actor can also edit memberships and sessions directly. Accepted (owner answer 7).
- **R10.** Write failures in the cutover window (§6), contained by the WAF rule (owner answer 5).

## 4. Wrong outcomes removed

| Finding | Removed by |
| --- | --- |
| Lost gate race shows `refused/not_found` | The gate UPSERT and finalize run in the grant batch. Finalize writes `ok` only if the gate points at this scan, otherwise `heads_up` naming `gate.last_scan_id`. `StaleScanAuthority` catch-alls go; the remaining refusals carry a reason (`config` → `SCAN_CONFIG_CHANGED`, `actor` → 401/403). |
| An assertion rollback quarantines the idempotency key | Assertions become RAISE reasons. A classified abort is definite, so the key is released. |
| "Let in again" fails after a staff sign-in or any revision | F6. Staff sign-in moves no epoch. |
| Committed check-in returns 409 `SCAN_UNCONFIRMED` | No post-commit fence on check-in. Display history comes from aggregates (W1-08). The code remains only where a live candidate's template fence is read after the commit (stop, choose, answer): the action committed, the response cannot be confirmed. |
| Bind overflow silently becomes `'0'` | Statements are ≤40 parameters by construction, and `stmt()` throws `SQL_BIND_BUDGET`. |
| Output fences fail on sync fields | F8 |
| Undo returns 404 after any org, template or pass revision | F7 |
| Undo replay is not idempotent | Replay checks the idempotency row only |
| `UNDO_SUPERSEDED` removed | A gate CAS miss returns 409 `UNDO_SUPERSEDED` |
| Scans from before the branch cannot be undone | No ledger authority is needed |
| Issuance mail cancelled by sign-out, idle expiry or an org edit | F13 |
| `DELIVERY_STALE` on any version bump | F12 |
| Idempotent replay returns 409 | The replay returns the stored result, and there is no post-commit re-fence |
| Issuance INSERT binds 94 parameters | ≤40 (section 5) |
| `orgs.updated_at` used as an epoch gives 403 on settings saves, and bulk actions abort | `access_revision`; settings CAS returns 409; each bulk item gets its own grant |
| Transfer START binds 97 parameters; a release approved mid-transfer wedges it | `row_version` and INSERT…SELECT. Finish compares `row_version` and the current head. W1-11 owns the abandon path. |
| One unusable template disables the door | F5: only the scanned pass's template is checked |
| A revision race logs the device out | Only a lost credential unpairs (`scannerCredentialLost`, the `credential_epoch` row above). Any other move returns 409 and the client refetches. |
| Report and staff sign-in return 409 after commit | The grant is the check; the post-commit compare is deleted |
| Captures vanish after a pass edit | F17 |
| The connection fence budget is unmeasured, about 40+33 queries per ref | One grant per item write |
| sql-balance rewrites expression-position `FROM` | Deleted: `stmt` binds the SQL as written; statements are built within D1's depth |

**Revision 2 additions:**
- **Retry after a lost response returns 409 for the user's own change:** removed by the idempotency key or the post-state check (§1.2).
- **The lookup backfill bumps every pass after cutover:** removed by the `OLD.x IS NOT NULL` rule for `scan_code`, `barcode_hash` and `lookup_hash`.
- **An event config edit makes door devices return 409:**
  - the scanner client refetches its config and retries once with the same idempotency key, automatically;
  - only a second 409 reaches staff.
  - Test: a scan sent while the event is being edited returns `ok` after one retry.

## 5. Limits

Measured by `platform/authority.test.ts` ("statement corpus") and `authority-corpus.test.ts`, which also compile every statement on local D1.

| Statement | Binds | Size |
| --- | --- | --- |
| Grant, tenant session with the org revision and five epoch checks | 23 | 1.76 KB |
| Grant, API key | 19 | 1.55 KB |
| Grant, scanner | 20 | 1.57 KB |
| Grant, platform admin | 23 | 1.75 KB |
| A one-column write | 3 | |

Each epoch check adds 2 binds and about 150 bytes.

- **Caps** (`authority-statements.ts`): a write binds at most 40 values (`WRITE_PARAM_BUDGET`), an included read part and the grant at most 90 (`PARAM_BUDGET`), any statement at most 32 KB. A breach throws `SQL_BIND_BUDGET` or `SQL_SIZE_BUDGET`.
- **D1 limits that shape the SQL:** the bind limit is the highest `?N` index, not the number of uses. Expression depth is 100 (a flat `OR` chain of 95 terms passes, 98 fail; `EXISTS` nesting 12 levels pass, 14 fail). A table or result has at most 100 columns (`passes` has 61). Keep checks flat: at most 2 nested `EXISTS` inside the grant `CASE`.
- **Removed:** `platform/sql-balance.ts`, `platform/sql-tokens.ts` and `scan/repo-secret-binds.ts`. `stmt` (alias `exactStmt`) prepares the SQL unchanged, so depth is the author's: staged CTEs and `scanConjunction` grouping keep scan guards under 100. `tools/authority-scope-bans.ts` fails a `scan-ephemeral` bind label, `json_extract('[]'`, a `balanceSql*` name, an import of a deleted fence module, and `credentialRefKeysetSql` outside `passes/repo-credential-keyset.ts` and `wallet-providers/` (`KEYSET_SQL_OWNERS`).

## 6. Migration and cutover

The cutover ran 2026-11-18 (`docs/operations.md`, "Cutover from schema 0024"). This section keeps the design decisions.

### 6.1 Migrations

| Migration | Authority change |
| --- | --- |
| `0029` | `org_memberships`, `org_invitations`, `orgs.access_revision` with bump and monotonic triggers, role-name guard, no-replace guards |
| `0030`, `0042` | pass lifecycle and credential generations; transfer guards compare `pass_credential_transfers.source_row_version` and the current release head |
| `0031`, `0038` | `template_releases` (immutable, no-replace), the `legacy` source |
| `0039` | `api_keys` identity immutable, no-replace |
| `0075` | `api_key_terminals` (fixed key-to-terminal binding), `scans.api_key_id` |
| `0044` | `connections_generation_bump`; item claims carry `legacy_pass_row_version` and `claim_row_version` |
| `0045` | issuance delivery guard on generations plus `transfer_id` |
| `0047` | `sessions` identity, CSRF secret, lifetime, `roles` and `amr` immutable; `scanners_credential_revision` dropped by `0063` |
| `0041`, `0051` | unreferenced proof tables and triggers dropped |
| `0052` | epochs and their triggers, `authority_grants`, the sentinel table, the head view, fixed-column and no-replace guards, `retired_api_key_ids`, `template_version_hashes` (write-once content hash per version and per asset), the three cancel-broadcast triggers |
| `0053` | `branding_gc_queue` |
| `0055` | a verified holder attaches to a pass with a static credential without a transfer |
| `0056`, `0057` | blueprints; indexes. Additive: they do not touch the cutover window |
| `0058` | `scans.session_id`: a passless replay must come from the scanning session that claimed the scan. Additive |
| `0059`, `0065` | pass download, bundle and device tokens stored as MACs with sealed copies; `pass_versions.pass_json` never carries `authenticationToken`. One-way: the previous Worker fails against them (6.2, 6.3) |
| `0061` | drops `scan_asset_grant_provenance` and its triggers; `credential_ref_keyset_insert_guard` recreated without the provenance term. Grants are stateless |
| `0063` | drops `scanners_credential_revision`; scanner authority is `credential_epoch`. Adds `scanners_updated_at_monotonic`. Additive-safe: the old Worker's writes satisfy no trigger and need none |
| `0064` | `scanners_revision_no_replace_update` and `pass_credential_no_replace_update` fire only when a guarded column is written (`BEFORE UPDATE OF ...`); same checks and messages |
| `0069` | `token_remac_marks` and a MAC may replace a MAC under a mark (cron `tokens.remac`) |
| `0070` | post-cutover: drops `scanning_config_revisions`, the seal sweep indexes and the plain-to-MAC branch of six triggers |

Migrations already applied are never edited; new schema takes the next free number.

### 6.2 The window between migrate and promote

The old Worker serves against the new schema until the bootstrap and promote steps. Every new column has a default, guards reject only decreases, grants are unused by it, and the no-replace guards refuse only a statement that re-inserts a key. `authority-baseline.test.ts` pins each old write path against the migrated schema.

| Old write | In the window | Why |
| --- | --- | --- |
| Holder edit, delete of an owned pass | fails | `0042` `pass_credential_transfer_required` |
| Owner link on pass create or sign-in, self-remove | succeeds | `0055` |
| Org settings upsert, profile and branding | ok; each moves `orgs.config_revision` | `0052` triggers |
| Template upload, baked upsert, scanner pairing and heartbeat, scan check-in claim, connection sync | ok | |
| Pass create, publish, edit, refresh, template upgrade, connection sync, credential transfer finish | fails | `0059`/`0065` refuse a plain `download_token` or `auth_token` and a stored `pass_json` with `authenticationToken` |
| Wallet device calls on a sealed pass | fails (401) | the old Worker compares the plain token; rows are sealed only after promote, so the window itself is unaffected |
| Template sync `INSERT ... ON CONFLICT (slug) DO NOTHING` for an existing org, and a re-sent `INSERT OR IGNORE INTO template_versions` | fails | BEFORE INSERT guards ignore `ON CONFLICT` and `OR IGNORE` |

The sync break is reachable only when a fresh baked build reaches the old Worker (a new build hash) or `templates.baked_hash` is cleared. The batch aborts as a whole and retries, so the effect is a delayed baked sync, not corruption. The new Worker has no `ensureOrgStmt` (deleted); the sync does not insert orgs.

Containment: the window is automated (seconds to minutes). Routes known to fail are blocked between migrate and promote by a temporary WAF rule (owner answer 5). Queue draining is best-effort; the new consumer accepts old-shaped messages and retains them as ignored (`queue.legacy_job_ignored`).

### 6.3 Rollback

Roll forward only once migrations have run (owner answer 6). `0059` and `0065` make this strict: a Worker older than them cannot serve sealed tokens and cannot create or publish a pass, so it is never promoted again. A Worker-only rollback is an emergency degraded mode: pause queue consumers first, keep transfer-starting routes blocked, then redeploy forward. A Time Travel restore to the pre-migration bookmark is the last resort and loses later writes.

### 6.4 Baked and legacy releases

- **Issuance and use are separate** (the issued-release rule). New issuance needs the scope's head. An existing pass is used under its template's head when the head is its own version or build, else under its own release and template version. Archived templates keep their passes working; deleted templates stop them.
- **Baked templates** get `system` releases only from the baked sync, because only the sync computes the verified content hash, the `template_version_hashes` row and the sealed preview extras. The sync scopes by the stored `templates.org_id`: an assigned baked template gets an org release, an unassigned one the platform release. Until the sync runs, baked templates cannot issue; existing baked passes still scan.
- **Uploaded templates** get a `legacy` release at their active version from `tools/bootstrap-tenancy.ts`. It is effective only as the scope's head at that version.
- **Adoption** needs `CF_VERSION` (`version_metadata`), so the new build's upload time orders after the old Worker's last sync.
- **Queued mail** (`{ to, attach }`, no `intent`) is bound by the bootstrap: it writes `payload.intent` without an actor (`legacy: true`) from the current pass and bundle state. Unbound rows cancel with `DELIVERY_UNBOUND`.

## 7. Enforcement and open work

### 7.1 Ownership scan

`tools/authority-scope.ts --strict` (in `npm run check:rules`) fails on a raw write to a guarded table, `OR REPLACE`, `updated_at = ?`, `new GrantedStatement`, a job context built outside `jobs/` and `workflows/`, and a fence-pattern match in a file that Appendix A does not list. Appendix A is machine-read: keep its `**WPx:**` headings and path tokens.

### 7.2 Open work

The scan and fence rewrite is complete. What is left:
- Wallet providers stay on column equality (7.3).
- A rekey of the keyset singleton must migrate every provider commitment column (instances, operations, refs, bindings, tombstones, candidates, approvals, releases, evidence) explicitly: provider SQL no longer re-checks the singleton per statement; services pin it once at entry and carry no commitment between layers. Provider SQL reads the stored value from the singleton through `pinnedKeysetSql` (`wallet-providers/repo-keyset-pin.ts`).

Done:

- Done: migration `0070` drops `scanning_config_revisions`.
- Done: `scan/repo-scanner-configuration-scope.ts` is deleted; the workspace observation carries the scanner's `config_epoch`.
- Done: the balancer, `sql-tokens`, `repo-secret-binds` and the legacy fence families are deleted; migration `0063` drops `scanners_credential_revision`. A scanner's `updated_at` is a label: authority is `credential_epoch`. The live ring's `revision` is an in-memory self-check of one actor snapshot, not a database compare. One credential-loss rule: every scanner path uses `scannerCredentialLost`.

- Done: migration `0070` drops the plain-to-MAC exception (0059 `passes_token_change_moves_link`, `passes_row_version_a`, the wallet-provider triggers; 0065 `passes_auth_token_change_follows_generation`, `pass_credential_transfer_required`, `passes_row_version_a`) after the seal sweep finished in production (no plain pass or bundle token, no unscrubbed `pass_versions`). The six triggers are the 0069 versions with the plain branch deleted. A plain value is refused outright, and 0070 starts with a guard that fails (and rolls back, unrecorded) while any plain token or stored device token is left; it also deletes the `tokens.sealCursor` setting. The cron `tokens.seal`, its code and the plaintext lookup are gone, and so are the sweep's partial indexes.
- Done: migration `0069` also lets a MAC replace a MAC (cron `tokens.remac`, after `MAC_KEY_VERSION` moved) while a `token_remac_marks` row names exactly that value; the job writes and deletes the mark in one batch. `token_remac_marks` is a guarded table (raw writes only in `passes/repo-pass-trusted.ts`). The marks stay: they are the only MAC-to-MAC path.
- Done: `LEGACY_REVISION_MS` is removed. An org revision is its `access_revision` and nothing else (`orgEpochMatchSql`, `orgRevision`, the principal's org check).
- Done: cron `keys.rewrap` moves every envelope (14 tables and the packed captured emails) to the newest KEK with `rewrapSecret`, a compare-and-set on `(kek_version, wrapped_dek)`; migration `0071` lets the three triggers that guard `credentials`, `wallet_provider_credentials` and `pass_credential_transfer_payloads` ignore a rewrap-shaped update (higher `kek_version`, new `wrapped_dek`, every other column equal), which AES-GCM makes unable to change a secret. No epoch or signing-identity revision moves. `rewrap-tables.test.ts` fails for a table with envelope columns, or a writer of one, that is not registered.
- Done: the evidence is not rekeyed but kept: `MAC_ROOT_V<n>` (HKDF-Extract of `KEK_V<n>`) derives every MAC key byte for byte and unwraps nothing, so `KEK_V1` can be deleted (`npm run keys:retire`) with the keyset commitment, tombstones, retention proofs, references and token MACs unchanged. Status checks the key ring (`keyRingProblems`: root 1 present, pins name a root, a root is older than the current KEK) and that each root matches its KEK. Runbook: operations.md, KEK rotation.
- Open (deferred): evidence root 2. After a confirmed V1 compromise, evidence made under root 1 stays open to offline guessing of its low-entropy inputs (barcodes, serials, scanner names) by anyone holding a database copy; a dual-root scheme (a per-row root tag, both commitments accepted, every `credentialRefKeysetSql` site and the 0043/0044 immutability triggers) would stop that for future evidence only, since retired credentials exist only as their MACs. Build it only after a confirmed compromise.

### 7.3 Provider track

Wallet providers (Google, Samsung) ship dark and stay on column equality:
- pass-column fences in `wallet-providers/` (`walletInstanceProofSql` in `repo-instance-proof.ts`, `repo-instance*.ts`, `repo-offers.ts`, `repo-sync-*.ts`, `repo-callbacks*.ts`, `repo-accounts.ts`, `repo-projection*.ts`, `repo-samsung-verification.ts`);
- the keyset: pinned once per entry with `requireCredentialRefKeyset` (`credential-keyset.ts`), no per-statement `credentialRefKeysetSql`; the triggers in `0043` and `0050` stay;
- `p.version`, `p.revision`, `p.release_id`, `p.credential_generation` and `p.lifecycle_generation` keep their meaning;
- `passes/repo-credential-transfer-finish.ts`, `passes/repo-ops-retention.ts` and `sandbox/repo.ts` call `providerRetirementCompleteSql` inside their grant checks; it takes no parameters and is vacuous while providers are dark.

Later adoption: an instance stores `pass_row_version` plus an account epoch, the proof becomes one equality inside a grant, and the keyset one pin per request.

## Appendix A. Fence-site ownership

Read by `tools/authority-scope.ts`: a file with a fence pattern must be listed here or be an authority file. The `WPx` names are keys of that scan, not live work packages. Paths are relative to `src/worker/modules/` unless they start with `src/`. Wallet-provider files are excluded.

**WP1:**
- `api-keys/repo.ts`
- `orgs/{repo,repo-members,membership-service}.ts`, `auth/repo.ts`
- `settings/repo.ts`
- `users/repo.ts`
- `passes/{http,repo-authority}.ts`
- `broadcasts/repo.ts`
- `holders/{repo,repo-blocks}.ts`
- `identities/repo-runs.ts`
- `audit/repo.ts` (the tenant read repeats the captured authority)

**WP-T:** `templates/{repo-authority,repo-eligible,repo-imports,repo-release-write,repo-releases,repo-source,repo-stale,repo-sync-release,repo-sync,repo-upload}.ts`

**WP2:**
- `passes/{repo-check-in,repo-connection-context,repo-credential-transfer,repo-credential-transfer-fences,repo-credential-transfer-finish,repo-credential-transfer-source,repo-detail-read,repo-history-image,repo-ops,repo-ops-retention,repo-release,repo-remove,repo-transfer-asset-gc,repo-workflow-releases,repo-write,repo-write-authority,repo-write-backfill,repo-write-insert-statement,repo-write-publish,repo-write-publish-snapshot,repo-write-retained,repo}.ts`
- `apple/repo-personalize.ts`
- `passes/repo-credential-keyset.ts` (helper kept; WP2 owns non-provider call sites)

**WP3:**
- `delivery/{repo-issuance-intent-fence,repo-issuance,repo-issued-email,repo-outbox,repo-outbox-enqueue,repo-outbox-refresh}.ts`
- `bundles/repo.ts`
- `sandbox/repo-capture.ts`

**WP4:** `connections/{access,repo,repo-legacy-inbox,repo-legacy-quarantine,repo-pass-refresh,repo-pass-snapshot,repo-runs,repo-sync,repo-sync-retention,repo-webhook-item-claims,repo-webhook-items,repo-webhook-legacy-unproven,repo-webhook-replay,repo-webhook-resolve,repo-webhook-retention,repo-webhook-retention-dispatch,repo-webhook-retention-stage}.ts`

**WP5a:** `scan/{repo-credential-keyset-authority,repo-credential-tombstones,repo-sample-scope-fence,guard}.ts`, plus the new `scan/authority-checks.ts`

**WP5b:**
- `scan/{act-check-in-success,act-held,act-stop,misses,repo-act-authority,repo-act-claim,repo-act-claim-current,repo-act-pass-fence,repo-pass-fence-release,repo-admission,repo-gates,repo-miss-authority,repo-scan-effect,repo-scans,rules,outcome}.ts`
- all other `scan/act*.ts`
- `events/service.ts`
- `src/web/scan/api/to-fail.ts`

**WP6:** `scan/{repo-undo,repo-undo-*,undo*,scan-undo-*}.ts`

**WP7:** `scan/{lookup,repo-lookup,repo-counts,repo-counts-query,repo-feed,repo-feed-console,repo-scan-history,repo-live-template-snapshot,repo-read-authority,repo-feed-scope,scan-predicate,repo-routes-display,repo-search,repo-scan-retention,repo-scan-passless,repo-scope-releases,repo-session-activity,session-activity}.ts`

**WP9:** `scan/{repo-device,repo-scanners-pair,pairing,pairing-session,pairing-token,scanners,scanning-devices,scanning-device-revocation,scanning-sessions,repo-scanning-sessions,setups,staff-admin,staff-admin-views,staff-pin,repo-staff-activity,repo-staff-pin-counters,events,events-mutations,repo-event-authority,repo-event-keyset,repo-events,repo-scanner-configuration-authority,scanning-workspace-report,routes-staff-session}.ts`

**WP7 (fence) and W1-13 (logic):** `scan/repo-lookup-backfill.ts`. WP7 converts its fence; W1-13 keeps the backfill logic.

**MT11:** `org-lifecycle/repo.ts` (the export request and the closed-org fence repeat the admin session test in SQL: no member grant exists on a closed org)

## Appendix B. Guarded tables

Raw writes to these tables are banned outside `platform/authority.ts`:
- **Platform:** `orgs`, `settings`, `org_memberships`, `org_invitations`, `api_keys`, `users` (status), `sessions` (revoke).
- **Passes and templates:** `passes`, `pass_assets`, `pass_credential_transfers`, `pass_credential_tombstones`, `pass_issuance_deliveries`, `templates`, `template_candidates`, `template_approvals`, `template_releases`.
- **Delivery:** `outbox`, `bundles`, `bundle_passes`, `captured_emails`, `sandbox_forwards`.
- **Connections:** `connections`, `connection_runs`, `connection_webhook_retention`, `connection_webhook_items`.
- **Scan:** `scans`, `scan_gates`, `scan_presence`, `scan_staff`, `scan_events`, `scan_event_templates`, `scanners`, `scanning_sessions`, `scanning_devices`, `scan_zones`, `scanning_session_zones`, `scan_place_revs`.
- **Ledger:** `pass_events`.
- **Wallet credentials (0112):** `wallet_credentials` (a platform row has a null org), `wallet_credential_versions`, `wallet_credential_events`, `wallet_credential_checks` (only `platform.job.wallet.credential_check` writes it: `RESTRICTED_TABLES`) and `wallet_enrolment_events`. The enrolment row, `wallet_provider_accounts`, is written by `include` parts under `org_mode.wallet.enrolment_*`.

**Allowlist:**
- the other `wallet_*` tables (provider track), which `authority-scope` does not scan, except the guarded ones above;
- session idle slide and `last_seen_*` updates;
- counters;
- test fixtures.

## Owner answers (2026-11-11)

1. The fence rewrites were built on the grant builder, not patched first.
2. Queued work (issuance email, scheduled broadcast, import) survives the initiator's sign-out and idle timeout. It stops only on membership or API-key revocation, org suspension, or a pass change such as void or holder transfer.
3. Work queued before a suspension stays cancelled after reactivation.
4. If a release is withdrawn after create, the issuance email still sends the pass that was created. Release checks apply at create and publish only.
5. Cutover window: a temporary Cloudflare WAF rule returns a short maintenance response on the affected admin write routes between migrate and promote. Pass pages, Wallet updates and scanning keep working.
6. Rollback: roll forward only once migrations have run. The Worker-only rollback stays documented as an emergency degraded mode, not a normal option.
7. Threat model: an operator with a D1-edit-only API token is out of scope (R9 accepted). The redundant retention HMAC re-check is dropped and documented.
8. Settings race: a scan racing an org settings save may use the previous settings for that one scan (R8 accepted). No fence, no 409 at the door.
9. Interpretations confirmed by the coordinator under answers 2 and 3: perpetual connection syncs are standing jobs, not queued one-off work, so they pause while an org is suspended and resume after reactivation. Disabling a user counts as revocation: it stops that user's queued work, which stays cancelled if the user is re-enabled, consistent with answer 3.

## As built: decisions

Decisions that differ from, or add to, the sections above. Each is checked against the code.

**Builder and grants**
- `grant(ctx, input)` returns synchronously; nothing runs until `commit()`. Scope comes from the purpose prefix. `grantedBatch(db, grants)` runs grants with identical `codes` in one transaction; mixing codes is `GRANT_BATCH_MIXED`. `jobGrant(ctx, input)` builds `system:` grants.
- A job brand: `createJobContext(env, kind)` for queue, cron and workflows; `createDetachedContext(env)` for `stores.ts`, the scan hub and the template registry. The token is private to `job-authority.ts`; `check:rules` lints importers.
- A platform principal or `system:` job that names an org needs it active. Connection purposes are `org_mode` and live (`CHECK`).
- Declared `edges` in `GUARDED_TABLES` bound child writes (`joined`, `insertJoined`); a test checks each edge against `PRAGMA foreign_key_list`.
- `retired_api_key_ids` and `api_keys_no_id_reuse`: a deleted key's id is never issued again.
- Re-keying `scanning_devices.scanner_id`, `settings.scope` or `key`, or `scan_event_templates` rows bumps the old and the new owner.
- Fixed-column guards (`<table>_fixed_columns`) cover `orgs`, `passes`, `scanners`, `scan_staff`, `scan_events`, `scanning_sessions` and `connections`. `created_by` may become NULL only when the user row is gone.

**Org revisions**
- `orgs.access_revision` is the principal's staleness check; settings and branding saves move `config_revision` only. Org and settings responses carry `configRevision`; `PATCH /orgs/{id}`, `PUT /orgs/{id}/branding/{slot}` and `PUT /settings` accept it (stale: 409 `SETTINGS_CHANGED`, see `docs/api.md`). The web clients share `lib/stale-save.ts`.
- A captured org revision must equal `orgs.access_revision`; a pre-cutover `updated_at` is refused (`LEGACY_REVISION_MS` is gone).

**Queued work**
- Triggers cancel scheduled broadcasts: `users_disable_cancels_broadcasts`, `orgs_inactive_cancels_broadcasts` (suspended or deleted) and `memberships_revoke_cancels_broadcasts`. They stay cancelled on reactivation (owner answers 3 and 9).
- `launchBroadcast` revives a broadcast to `scheduled` only while the org and the creator are live, else `failed`. `sendStepAllowed` (`broadcasts/run.ts`) runs before each chunk through a `jobGrant` (`org_mode.job.broadcast.send`). A re-invited creator does not pass: the membership must predate the broadcast.
- Platform grants for org create, status and delete take the admin session from the route.

**Releases and issuance**
- Issuance reads no asset bytes. `verifyStoredContent` checks the saved hash against the release's, recomputes the content hash from stored documents and metadata, and heads each stored R2 object for its declared size. Publication (`verifyCandidate` with `deep`) hashes the bytes. `registry.openAsset` verifies size and sha1 of an R2 asset on every open, so a bad swap is never cached by the pass build (`TEMPLATE_CONTENT_CHANGED`).
- `READ_PATH_WRITE_ALLOWLIST` (`repo-version-hashes.ts`) lists `template_version_hashes`: the first issuance of a pre-hash release writes its write-once row on a read.
- `bakedSyncComplete` requires the system head's `content_hash` to equal the saved hash, so a settled isolate resyncs after a migration.

**Scanning**
- Content is not authority. A publish, a version bump, a link generation change, a Wallet JSON replacement or a newer release never refuses a ticket; a void, removal, transfer, quarantine, template reassignment or replaced barcode does (`scan/scan-pass-checks.ts`).
- Undo re-derives the actor from the request and checks its epochs at commit. The `scan.undone` event carries no authority or MAC, and nothing stored is read as authority, so undo works on scans from before the epoch cutover. The approver is checked by value (role, disabled, `pin_hash`).
- Staff changes refuse with `staff` (409 `SCAN_STAFF_CHANGED`); the device stays paired.
- Mode: creates and event writes are `org_mode`; edits of an existing scanner, session, device or staff row are `org` scope, by id.
- A scan grant leaves display-history rows, which may fail on their own, to one batch after the commit; it logs `SCAN_FINISH_DEGRADED` and never rolls back the scan. The PIN refund rides in the commit grant (`refundParts`, no guarded table, so it cannot fail the scan); photo grants are stateless HMACs and write nothing.
- `commitWith(reads)` takes `afterRead` values (`platform/authority-after.ts`): fixed read-only SQL run after the release in the same transaction.

**Holders**
- The transfer START and FINISH grants need an active org; `pass_credential_transfer_insert_guard` also refuses a re-sign there. A session holder with `unlink: true` (`holder_remove`, built only by `unlinkOwner`) may take a pass off its account in a suspended or deleted org.

**Tests**
- `test/helpers/triggers.ts`: `editSessionAuthority`, `editFixedColumns`, `allowInvalidRoleNames` (the worker setup restores dropped triggers after each test). `runOne` / `runExactly` (`test/helpers/exact-rows.ts`) append `RETURNING 1` and assert the row count.

Remote D1 check (2026-11-18): a batch whose grant row survives to commit is rejected with `D1 DB was reset and rolled back to its last known good state because the application left the database in a state where constraints were violated: FOREIGN KEY`. Its rows roll back, and the same request then commits a normal batch, so the Worker keeps serving. Local D1 additionally logs `broken.inputGateBroken`.
