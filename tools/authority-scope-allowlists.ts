// Reviewed exceptions to the authority-scope lint (tools/authority-scope.ts). Every entry needs a reason.

/** Reviewed `OR REPLACE` sites (section 1.3). Anything else needs an entry in the design doc first. */
export const REPLACE_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/delivery/repo-devices.ts':
    'push_results: per-outbox result keyed (outbox_id, device_id), holds no authority',
};

/**
 * A reviewed file and the exact raw writes it may hold, one `table:fingerprint` per statement (the
 * fingerprint hashes the statement with comments and whitespace normalized away, constants
 * (same-file or imported from a file in the tree) inlined into `${...}`, other interpolations kept as text, and `+ ...` tails joined on; `@use` marks each
 * further call site of a constant that holds a statement, in its own file or one that imports it). A new
 * statement, or an edited one (a widened WHERE, another column), is a finding until it is a grant or a
 * design decision re-pins it here. `node tools/authority-scope.ts --pins` prints the current pins.
 */
export interface RawWriteEntry {
  reason: string;
  writes: string[];
}

/**
 * Files whose remaining raw writes to a guarded table are reviewed and intended. Each needs a reason that
 * names why no grant principal exists or applies. Everything else is a finding.
 */
export const RAW_WRITE_ALLOWLIST: Record<string, RawWriteEntry> = {
  'src/worker/modules/orgs/repo-branding.ts': {
    reason:
      'branding_dirty_at is volatile bookkeeping for the branding reissue debounce, not an authority column',
    writes: ['orgs:0f6e16ce1927', 'orgs:f22092f04dca'],
  },
  'src/worker/modules/auth/repo-sessions.ts': {
    reason:
      "sign-in creates the session (no principal exists yet); idle slide is on the allowlist; sign-out revokes the caller's own session",
    writes: [
      'sessions:52e6852de8c6',
      'sessions:b0a06a56c10d',
      'sessions:2c6fe2b1d5d5',
      'sessions:d0c2564ed9b5',
    ],
  },
  'src/worker/modules/auth/repo.ts': {
    reason:
      'sign-in finds or creates the user, stamps last login and settles an unproven primary address (#73) before any principal exists',
    writes: [
      'users:60e8f7814206',
      'users:21bde5076000',
      'users:c3b10ce30da0',
      'users:ab5c6955ad57',
    ],
  },
  'src/worker/modules/me/repo.ts': {
    reason: 'a user edits their own primary email under their own session',
    writes: ['users:5cbb5673e06f'],
  },
  'src/worker/modules/orgs/repo-members.ts': {
    reason:
      'invitation accept (the token, with a strong session, is the authority); manager writes are org.member.* grants',
    writes: ['org_invitations:4b6bc4ab06f4', 'org_memberships:70b55e5c0f81'],
  },
  'src/worker/modules/settings/repo.ts': {
    reason: 'system-scope job values (cron runs, identity checks); the settings routes use grants',
    writes: ['settings:4b2f1a4579d8'],
  },
  'src/worker/modules/users/repo.ts': {
    reason:
      'primary-email change and email removal behind the admin route (requireAdmin session); status changes are platform.user.* grants',
    writes: ['users:cad0f516f74f'],
  },
  'src/worker/modules/channels/repo.ts': {
    reason:
      'pass_channel_copies is insert-once evidence written where a copy is delivered (bearer link or Apple device); it grants nothing and no tenant principal exists there',
    writes: ['pass_channel_copies:fd7ca700e78a'],
  },
  'src/worker/modules/scan/repo-scans.ts': {
    reason:
      "release, fail, quarantine and retention purge of the actor's own server-minted claim row: they run after authority is revoked and only close a claim; a scan takes effect only through scan.* grants. Also the daily test-mode window of staff notes (pass_notes by age), a platform job with no principal",
    writes: [
      'pass_notes:eaa253f3ccef',
      'scans:4d2be8302d2d',
      'scans:4d2be8302d2d@use',
      'scans:4d2be8302d2d@use',
      'scans:4d2be8302d2d@use',
      'scans:4d2be8302d2d@use',
      'scans:4d2be8302d2d@use',
      'scans:4df40f2dbb58',
      'scans:5f5758655d9a',
      'scans:8f59dc9eb4bd',
      'scans:e474881b9c47',
      'scans:af3fe65731a1',
      'scans:bece3e07a044',
    ],
  },
  'src/worker/modules/scan/repo-act-claim.ts': {
    reason:
      "reopen, quarantine and fail of the actor's own claim generation after a key collision, still fenced by the claim authority predicate; a fresh claim is the org_mode.scan.claim upsert. Also the offline flag on a done scan a queued read produced (set once, not authority)",
    writes: ['scans:eae11c80b490', 'scans:6dcbf3a04bfc'],
  },
  'src/worker/modules/scan/repo-gate-recovery.ts': {
    reason:
      'server-side recovery of a crashed claim: quarantines the claim and restores only gate and presence snapshots that still match what the crashed scan wrote; it runs from the recovery job (or once per collision) and takes no actor authority',
    writes: ['scan_gates:75d38041fa52', 'scan_gates:c83de86fd208', 'scans:88345d12eee0'],
  },
  'src/worker/modules/scan/repo-counts.ts': {
    reason:
      'scan_events.expected is an idempotent cache fill on a GET (volatile, derived from the guarded event config_epoch); it is not authority',
    writes: ['scan_events:47ca69fff7fc', 'scan_events:47ca69fff7fc@use'],
  },
  'src/worker/modules/events/repo.ts': {
    reason:
      'pass_events is an append-only ledger written by recordPassEvent; WP5b owns the grant conversion',
    writes: ['pass_events:5cde459e82f9', 'pass_events:7ac7f822118d'],
  },
  'src/worker/modules/apple/repo-events.ts': {
    reason:
      'device.fetched ledger rows from the Apple device protocol, fenced in SQL by the credential serial and generation; the device principal has no ledger purpose',
    writes: ['pass_events:93fa910529e3'],
  },
  'src/worker/modules/passes/repo-remove-compensate.ts': {
    reason:
      "exact-state compensation of this request's own removal claim (must run after authority is revoked) and claims for trusted callers without tenant authority: fixtures and service tests, and the deferred runs (pass import undo, bulk run remove), whose claim carries the starter's proof in the same UPDATE; routes take the grants in repo-remove.ts",
    writes: [
      'passes:8a543a1f29ac',
      'passes:d03344a9a7dc',
      'passes:dbb5af80fe98',
      'passes:ec2d184a0290',
    ],
  },
  'src/worker/modules/passes/repo-pass-trusted.ts': {
    reason:
      'link rotation, refresh claim, soft delete and the re-MAC of a stored token MAC under a new root (cron tokens.remac: a token_remac_marks or bundle_remac_marks row, the CAS update and the mark removal in one batch; a join link or bundle token is one CAS update) for callers with no tenant authority (holder refresh, fixtures, service tests); tenant requests take repo-pass-grants.ts',
    writes: [
      'bundle_remac_marks:2335a17039ba',
      'bundle_remac_marks:c55ee2c8e29c',
      'bundles:4d66feaeeccb',
      'join_links:4a5b982fa241',
      'passes:3461614bd186',
      'passes:840d9eabd590',
      'passes:840d9eabd590@use',
      'passes:8576df69c778',
      'passes:8576df69c778@use',
      'passes:a565c31165b3',
      'passes:a978e7f9948b',
      'passes:a978e7f9948b@use',
      'passes:d60295b23550',
      'passes:d60295b23550@use',
      'token_remac_marks:b15f0832d2e7',
      'token_remac_marks:d1185d6069bd',
    ],
  },
  'src/worker/modules/passes/repo-connection-state.ts': {
    reason:
      'sync_error_code is volatile bookkeeping stamped by connection sync behind a full pass and release snapshot',
    writes: ['passes:2fdfca846d49'],
  },
  'src/worker/modules/passes/repo-history-assets.ts': {
    reason:
      'exact-state rollback of an asset write after a failed rebuild, and trusted callers; tenant writes take replaceAssetGranted',
    writes: [
      'pass_assets:33792f6657b0',
      'pass_assets:7de21d5f7819',
      'pass_assets:bbb4bf4399cf',
      'pass_assets:e988bb2b949a',
    ],
  },
  'src/worker/modules/passes/repo-history-image.ts': {
    reason:
      'commitImageMutation advances link_generation only for the exact-state rollback paths of asset and member photo writes and trusted callers; tenant writes take replaceAssetGranted and replaceMemberPhotoGranted',
    writes: ['passes:682818a1e9cf'],
  },
  'src/worker/modules/passes/repo-member-photo.ts': {
    reason:
      "exact-state compensation of this request's own photo write (after authority may be revoked) and trusted callers; tenant writes take replaceMemberPhotoGranted",
    writes: ['member_photos:454bce65b9b2', 'member_photos:e63fd03cf294'],
  },
  'src/worker/modules/passes/repo-ops-retention.ts': {
    reason:
      'retention purge of a soft-deleted pass past its grace period: server-selected ids behind a keyset commitment and scan retention proof, no principal',
    writes: ['passes:04303e1d6c73'],
  },
  'src/worker/modules/passes/repo-transfer-asset-gc.ts': {
    reason:
      'the transfer asset sweeper (no principal): GC of retired server-minted r2 keys, and recovery of an expired image stage that restores the exact staged pass_assets / member_photos row (UPDATE ... AS a|m, INSERT) and advances passes.link_generation, only while the stage still matches its pass incarnation and no transfer is pending',
    writes: [
      'member_photos:2ce965946654',
      'member_photos:61c8305aee02',
      'pass_assets:1ec1def172ab',
      'pass_assets:f5f08a195c71',
      'passes:a92c1702af5b',
    ],
  },
  'src/worker/modules/webhooks/repo-delivery-state.ts': {
    reason:
      'the capture of a signed request on a capture endpoint (developer org, Test; the triggers hold it to its own org, 600 an hour and 200 per endpoint), lane claim, attempt, retry, finish and cancel bookkeeping for deliveries created by the pass_events trigger (the trigger and composite FKs are the authority), plus the endpoint health and status writes no trigger authorizes (consecutive_failures, failing_since, last_success_at, lane_token, status = disabled with its cancel and audit row); no tenant principal at send time. Only webhooks/{deliver,dispatch,jobs,kick}.ts may import it (check-sizes boundary)',
    writes: [
      'webhook_attempts:14e5061ed595',
      'webhook_captures:394f11de3c79',
      'webhook_deliveries:32f816eb0de2',
      'webhook_deliveries:7aad02cd36d1',
      'webhook_deliveries:c4b8616238e6',
      'webhook_deliveries:f3354348cdcf',
      'webhook_endpoints:15238020ed80',
      'webhook_endpoints:42fc667a61e0',
      'webhook_endpoints:641fa0530214',
      'webhook_endpoints:a887b7fdf39d',
      'webhook_endpoints:ce93d6a8adaa',
      'webhook_endpoints:f0e71da67ea9',
    ],
  },
  'src/worker/modules/webhooks/repo-retention.ts': {
    reason:
      'daily purge of event_feed, deliveries and attempts per retention plan scope (held events excluded, receipt in the same batch), expired secrets, and test captures past 7 days with their hourly counters; platform job',
    writes: [
      'event_feed:8077696eb04f',
      'webhook_attempts:f8ab46ccf9f0',
      'webhook_capture_hours:1650ffd6f374',
      'webhook_captures:b9e00555955d',
      'webhook_deliveries:d8e809e58534',
      'webhook_endpoint_secrets:98644d3fe974',
    ],
  },
  'src/worker/modules/delivery/repo-outbox-processing.ts': {
    reason:
      'outbox lease, retry and finish bookkeeping for a row already authorized at queue time, (the outbox retention purge moved to retention/repo-sweep.ts); the provider boundary is a grant (repo-provider-attempt.ts)',
    writes: [
      'outbox:25f751c88a47',
      'outbox:2765ae869719',
      'outbox:7ad4bf487573',
      'outbox:9de783f49135',
      'outbox:a99e262e1616',
      'outbox:b161b0723bc6',
      'outbox:b57a00ed96d9',
      'outbox:c344a3932d66',
      'outbox:c884cec3a55c',
      'outbox:e8ce3b00eadb',
    ],
  },
  'src/worker/modules/delivery/repo-binding.ts': {
    reason:
      'outbox lease check, provider acceptance and uncertain-outcome settlement for a leased row; no principal acts on it',
    writes: ['outbox:21c26f941048', 'outbox:453ccd650aed', 'outbox:b26971782270'],
  },
  'src/worker/modules/delivery/repo-devices.ts': {
    reason:
      'push device outcomes (outbox cancel, pass_events) written while delivering a leased push',
    writes: ['outbox:965be41de4bd', 'outbox:ea24d4f8a142', 'pass_events:a5300ed933c7'],
  },
  'src/worker/modules/delivery/repo-issuance-recovery.ts': {
    reason:
      'issuance delivery retry deferral and stale cancellation by the scheduler; cancelling cannot widen authority',
    writes: [
      'pass_issuance_deliveries:1ddc36afd484',
      'pass_issuance_deliveries:69f9a8d354ba',
      'pass_issuance_deliveries:8bb2e8f960c0',
    ],
  },
  'src/worker/modules/sandbox/repo.ts': {
    reason:
      'daily test-data retention purge (captured_emails, bundles); a platform job with no tenant principal',
    writes: ['bundles:f644c9a26cf2', 'captured_emails:54483bed5926'],
  },
  'src/worker/modules/retention/repo-sweep.ts': {
    reason:
      'the daily retention sweep (platform job, no principal) deletes server-selected rowids of live scans, live pass events, finished outbox rows, ended roll calls and staff notes (with the scans window, holds honoured) and photos of voided or removed passes (member_photos, by pass id); each delete repeats the class condition, scope and hold check, and runs only while the receipt that records it exists in the same batch',
    writes: [
      'member_photos:d2d252b6afeb',
      'outbox:72eab727054c',
      'pass_events:ab54fbcb111e',
      'pass_notes:a78a2119f896',
      'roll_calls:64348c6387af',
      'scans:b9e37001ebbc',
    ],
  },
  'src/worker/modules/retention/repo-receipts.ts': {
    reason:
      'retention receipts and their anchors are append-only bookkeeping of platform jobs and the erasure finisher (no principal): a MAC-chained row per delete run, and the 6-year trim that moves the MACed anchor forward first; table triggers refuse update and early delete',
    writes: [
      'retention_receipt_anchors:be676f0b2666',
      'retention_receipts:71b1efea96ea',
      'retention_receipts:726f943d12d9',
    ],
  },
  'src/worker/modules/keys/repo-rewrap.ts': {
    reason:
      'cron keys.rewrap moves an envelope to the newest KEK (kek_version and wrapped_dek only), a compare-and-set on the envelope it read; platform job with no tenant principal, and no authority column changes (docs/design/authority-epochs.md, 7.2)',
    writes: [
      'captured_emails:511fe05ea909',
      'connection_webhook_retention:84821c1d359b',
      'nfc_tag_keys:2c11078e8a24',
      'nfc_tag_sun:7326dc55a42b',
      'wallet_credential_versions:7751be830869',
      'webhook_endpoint_secrets:b1f2bc9c7907',
    ],
  },
};

/** Files that build a write whose table is interpolated or concatenated. Each says what fixes the table. */
export const DYNAMIC_WRITE_ALLOWLIST: Record<string, string> = {
  'src/worker/platform/batched.ts':
    'deleteInBatches takes its table from the caller; a call that names a guarded table is a raw-guarded-write finding at the call site',
  'src/worker/platform/db.ts':
    'casUpdate takes its table from the caller (identifier-checked); a call that names a guarded table is a raw-guarded-write finding at the call site',
  'src/worker/modules/developer/repo-reset.ts':
    "a sandbox reset deletes Test rows of the person's own developer org from the fixed RESET_TABLES list (a constant keyed object, never a request value); every statement repeats RESETTING: developer org, active, sandbox open and owned, the reset's stamp the track start, no hold",
  'src/worker/modules/org-lifecycle/repo-purge.ts':
    'the org purge (platform job, no principal) deletes the tables of PURGE_STEPS; every delete repeats the closed, in-purge and no-hold test, and a schema test proves each table is a step, a cascade of one, kept or not tenant data',
  'src/worker/modules/passes/repo-credential-transfer.ts':
    'deviceRows builds a writePart: buildPart lints the expanded target at runtime (one target, no guarded table, tenant and pass ties)',
};

/**
 * `rawCheck` existence tests over a tenant table that carry no tenant term, keyed `file#table`. A new one
 * uses `tenantCheck` with `{org}`. Each entry names what ties the row to the grant's tenant instead.
 */
export const UNTENANTED_CHECK_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/developer/repo-grants.ts#developer_sandboxes':
    "the owner's own close: the check asks that the person has a sandbox, and the grant's org write is pinned to the org id the service read for that person",
  'src/worker/modules/developer/repo-grants-reset.ts#orgs':
    "the reopen window: the check reads the one org row by the id the service read from the person's own sandbox, and the same grant's org write is pinned to that id",
  'src/worker/modules/developer/repo-grants-reset.ts#developer_sandboxes':
    "the owner's own reset or reopen: the check names the org id the service read from the person's own sandbox row and the person's user id, and the grant's writes are pinned to that same org id",
  'src/worker/modules/passes/repo-authority.ts#api_keys':
    "capabilityChecks: k.id is the grant's own API-key principal (the same authority object), which the actor row resolves in its tenant",
  'src/worker/modules/passes/repo-authority.ts#org_memberships':
    "membershipCapability: m.id is the grant's own membership principal, which the actor row resolves in its tenant",
  'src/worker/modules/connections/repo-grants.ts#connection_webhook_retention':
    'itemReleaseMatches: every caller adds retentionIs (exactlyOne in the tenant) for the same retention row',
  'src/worker/modules/connections/repo-grants.ts#workflow_runs':
    'workflowTracked: the server-minted sync run of a connection the same grant pins with connectionIs',
  'src/worker/modules/connections/repo-webhook-item-claims.ts#connection_webhook_retention':
    'the release snapshot of the retention row the same grant pins with retentionIs',
  'src/worker/modules/connections/repo-webhook-replay.ts#connection_webhook_retention':
    'the state of the retention row the same grant pins with retentionIs',
  'src/worker/modules/connections/repo-webhook-resolve.ts#connection_webhook_retention':
    'the state of the retention row the same grant pins with retentionIs',
  'src/worker/modules/sandbox/repo-capture.ts#outbox':
    "the payload of the outbox row this capture leased; the delivery grant's checks pin its pass with rowIs",
  'src/worker/modules/delivery/repo-delivery-checks.ts#pass_issuance_deliveries':
    'issuanceLineageCheck: the issuance of a pass the delivery grant pins to the tenant (rowIs passes or the binding checks)',
  'src/worker/modules/delivery/repo-delivery-checks.ts#passes':
    'issuanceLineageCheck: the pass the delivery grant pins to the tenant (rowIs passes or the binding checks)',
  'src/worker/modules/delivery/repo-delivery-checks.ts#pass_credential_transfers':
    'issuanceLineageCheck: the transfer the issuance row names, of a pass pinned to the tenant',
  'src/worker/modules/scan/repo-scan-checks.ts#scanners':
    'deviceAwakeCheck: the scanner scanActorChecks pins to the tenant with rowIs in the same grant',
  'src/worker/modules/scan/repo-scan-checks.ts#scanning_sessions':
    'sessionAcceptsTemplateCheck: the session scanActorChecks pins to the tenant with rowIs in the same grant',
  'src/worker/modules/passes/repo-create-checks.ts#template_releases':
    'releaseSnapshotCheck: the release createGrant also checks with releaseHead and releaseOrgCheck, which tie it to the tenant (or the platform head)',
};
