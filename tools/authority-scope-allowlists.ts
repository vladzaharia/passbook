// Reviewed exceptions to the authority-scope lint (tools/authority-scope.ts). Every entry needs a reason.

/** Reviewed `OR REPLACE` sites (section 1.3). Anything else needs an entry in the design doc first. */
export const REPLACE_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/delivery/repo-devices.ts':
    'push_results: per-outbox result keyed (outbox_id, device_id), holds no authority',
};

/**
 * Files whose remaining raw writes to a guarded table are reviewed and intended. Each needs a reason that
 * names why no grant principal exists or applies. Everything else is a finding.
 */
export const RAW_WRITE_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/orgs/repo-branding.ts':
    'branding_dirty_at is volatile bookkeeping for the branding reissue debounce, not an authority column',
  'src/worker/modules/auth/repo-sessions.ts':
    "sign-in creates the session (no principal exists yet); idle slide is on the allowlist; sign-out revokes the caller's own session",
  'src/worker/modules/auth/repo.ts':
    'sign-in finds or creates the user and stamps last login before any principal exists',
  'src/worker/modules/me/repo.ts': 'a user edits their own primary email under their own session',
  'src/worker/modules/orgs/repo.ts':
    'trusted callers without an admin session (fixtures, service tests): setOrgBranding, setOrgStatus, markOrgDeleted, insertOrg. Routes use platform.org.* grants',
  'src/worker/modules/orgs/repo-org-writes.ts':
    'the CAS-only org edit for a trusted caller without authority; tenant edits are org.org.update grants',
  'src/worker/modules/orgs/repo-members.ts':
    'invitation accept (the token is the authority) and the revokeMembership fixture helper; manager writes are org.member.* grants',
  'src/worker/modules/settings/repo.ts':
    'trusted org settings writes without authority (fixtures) and system-scope job values; routes use settings grants',
  'src/worker/modules/users/repo.ts':
    'trusted setStatus for service callers without an admin session; the route uses platform.user.* grants',
  'src/worker/modules/scan/repo-scans.ts':
    "release, fail, quarantine and retention purge of the actor's own server-minted claim row: they run after authority is revoked and only close a claim; a scan takes effect only through scan.* grants",
  'src/worker/modules/scan/repo-act-claim.ts':
    "reopen, quarantine and fail of the actor's own claim generation after a key collision, still fenced by the claim authority predicate; a fresh claim is the org_mode.scan.claim upsert",
  'src/worker/modules/scan/repo-gate-recovery.ts':
    'server-side recovery of a crashed claim: quarantines the claim and restores only gate and presence snapshots that still match what the crashed scan wrote; it runs from the recovery job (or once per collision) and takes no actor authority',
  'src/worker/modules/scan/repo-scans-write.ts':
    'claim, finalize and ledger statements kept for fixtures and the reconcile tests; production writes are scan.* grants',
  'src/worker/modules/scan/repo-counts.ts':
    'scan_events.expected is an idempotent cache fill on a GET (volatile, derived from the guarded event config_epoch); it is not authority',
  'src/worker/modules/events/repo.ts':
    'pass_events is an append-only ledger written by recordPassEvent; WP5b owns the grant conversion',
  'src/worker/modules/apple/repo-events.ts':
    'device.fetched ledger rows from the Apple device protocol, fenced in SQL by the credential serial and generation; the device principal has no ledger purpose',
  'src/worker/modules/passes/repo-remove-compensate.ts':
    "exact-state compensation of this request's own removal claim (must run after authority is revoked) and claims for trusted callers without tenant authority; routes take the grants in repo-remove.ts",
  'src/worker/modules/passes/repo-pass-trusted.ts':
    'link rotation, refresh claim and soft delete for callers with no tenant authority (holder refresh, fixtures, service tests); tenant requests take repo-pass-grants.ts',
  'src/worker/modules/passes/repo-connection-state.ts':
    'sync_error_code is volatile bookkeeping stamped by connection sync behind a full pass and release snapshot',
  'src/worker/modules/passes/repo-history-assets.ts':
    'exact-state rollback of an asset write after a failed rebuild, and trusted callers; tenant writes take replaceAssetGranted',
  'src/worker/modules/passes/repo-history-image.ts':
    'commitImageMutation advances link_generation only for the exact-state rollback paths of asset and member photo writes and trusted callers; tenant writes take replaceAssetGranted and replaceMemberPhotoGranted',
  'src/worker/modules/passes/repo-member-photo.ts':
    "exact-state compensation of this request's own photo write (after authority may be revoked) and trusted callers; tenant writes take replaceMemberPhotoGranted",
  'src/worker/modules/passes/repo-ops-retention.ts':
    'retention purge of a soft-deleted pass past its grace period: server-selected ids behind a keyset commitment and scan retention proof, no principal',
  'src/worker/modules/passes/repo-transfer-asset-gc.ts':
    'the transfer asset sweeper (no principal): GC of retired server-minted r2 keys, and recovery of an expired image stage that restores the exact staged pass_assets / member_photos row (UPDATE ... AS a|m, INSERT) and advances passes.link_generation, only while the stage still matches its pass incarnation and no transfer is pending',
  'src/worker/modules/delivery/repo-outbox-processing.ts':
    'outbox lease, retry and finish bookkeeping for a row already authorized at queue time, and the sent/failed outbox purge (deleteInBatches); the provider boundary is a grant (repo-provider-attempt.ts)',
  'src/worker/modules/delivery/repo-binding.ts':
    'outbox lease check, provider acceptance and uncertain-outcome settlement for a leased row; no principal acts on it',
  'src/worker/modules/delivery/repo-devices.ts':
    'push device outcomes (outbox cancel, pass_events) written while delivering a leased push',
  'src/worker/modules/delivery/repo-issuance-recovery.ts':
    'issuance delivery retry deferral and stale cancellation by the scheduler; cancelling cannot widen authority',
  'src/worker/modules/sandbox/repo.ts':
    'daily test-data retention purge (captured_emails, bundles); a platform job with no tenant principal',
};

/** Files that build a write whose table is interpolated or concatenated. Each says what fixes the table. */
export const DYNAMIC_WRITE_ALLOWLIST: Record<string, string> = {
  'src/worker/platform/batched.ts':
    'deleteInBatches takes its table from the caller; a call that names a guarded table is a raw-guarded-write finding at the call site',
  'src/worker/platform/db.ts':
    'casUpdate takes its table from the caller (identifier-checked); a call that names a guarded table is a raw-guarded-write finding at the call site',
  'src/worker/modules/passes/repo-credential-transfer.ts':
    'deviceRows builds a writePart: buildPart lints the expanded target at runtime (one target, no guarded table, tenant and pass ties)',
};

/**
 * `rawCheck` existence tests over a tenant table that carry no tenant term, keyed `file#table`. A new one
 * uses `tenantCheck` with `{org}`. Each entry names what ties the row to the grant's tenant instead.
 */
export const UNTENANTED_CHECK_ALLOWLIST: Record<string, string> = {
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
