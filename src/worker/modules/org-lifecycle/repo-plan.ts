/**
 * What a purge removes, in the order it removes it. `where` binds the org id as `?1`. A step is one table, or
 * a group that runs in one batch with foreign keys deferred (tables that reference each other). A test reads
 * the migrated schema: every table is a step, removed by a cascade of a step, kept, or not tenant data, and
 * no foreign key points at a table a step has already emptied.
 */
export interface PurgeStep {
  table: string;
  where: string;
  /** Deleted in slices of 1000 rows by rowid (a table that can be large; none of these is WITHOUT ROWID). */
  slices?: true;
}

const inOrg = (table: string): PurgeStep => ({ table, where: 'org_id = ?1' });
const passesOf = 'pass_id IN (SELECT id FROM passes WHERE org_id = ?1)';
const walletCredentialsOf = (column: string) =>
  `${column} IN (SELECT id FROM wallet_credentials WHERE org_id = ?1)`;
const templatesOf = 'template_id IN (SELECT id FROM templates WHERE org_id = ?1)';

/** Passes go through `deletePassRows`, between the steps before and after them. */
export const PASSES_AT = 'passes';

export const PURGE_STEPS: readonly (PurgeStep | readonly PurgeStep[])[] = [
  { table: 'revisions', where: passesOf },
  { table: 'pass_transfer_asset_recoveries', where: passesOf },
  inOrg('pass_notes'),
  { ...inOrg('scans'), slices: true },
  inOrg('scan_events'),
  inOrg('scan_place_revs'),
  inOrg('scan_offline_reads'),
  inOrg('scan_session_changes'),
  inOrg('scan_offline_state'),
  inOrg('roll_calls'),
  inOrg('scan_staff'),
  inOrg('scanners'),
  inOrg('scanning_sessions'),
  inOrg('scan_zones'),
  inOrg('webhook_endpoints'),
  inOrg('webhook_capture_hours'),
  // Before the keys and the org invitations they point at. A claim points at both kinds of invitation, and a
  // rule ends with its org.
  inOrg('idp_group_rules'),
  {
    table: 'idp_invite_claims',
    where:
      'org_invitation_id IN (SELECT id FROM org_invitations WHERE org_id = ?1) OR developer_invitation_id IN (SELECT id FROM developer_invitations WHERE org_id = ?1)',
  },
  inOrg('developer_sponsors'),
  {
    table: 'developer_invite_setups',
    where: 'invitation_id IN (SELECT id FROM developer_invitations WHERE org_id = ?1)',
  },
  inOrg('developer_invitations'),
  inOrg('api_keys'),
  inOrg('outbox'),
  inOrg('captured_emails'),
  {
    table: 'connection_webhook_items',
    where: 'retention_id IN (SELECT id FROM connection_webhook_retention WHERE org_id = ?1)',
  },
  inOrg('connection_webhook_retention'),
  inOrg('connection_webhook_legacy_sources'),
  inOrg('connection_webhook_replays'),
  inOrg('connections'),
  inOrg('bundles'),
  inOrg('broadcasts'),
  inOrg('message_rules'),
  inOrg('nfc_tags'),
  inOrg('nfc_tag_keysets'),
  inOrg('nfc_tag_types'),
  inOrg('pass_import_mappings'),
  inOrg('pass_imports'),
  inOrg('pass_bulk_runs'),
  inOrg('pass_bulk_locks'),
  inOrg('pass_views'),
  inOrg('template_imports'),
  inOrg('workflow_runs'),
  inOrg('identity_runs'),
  inOrg('wallet_org_cards'),
  inOrg('idempotency_keys'),
  inOrg('idempotent_requests'),
  { ...inOrg('request_log'), slices: true },
  inOrg('request_log_budget'),
  inOrg('org_entitlement_overrides'),
  inOrg('branding_gc_queue'),
  inOrg('org_reply_to'),
  inOrg('data_requests'),
  inOrg('retention_floors'),
  inOrg('org_exports'),
  { table: 'settings', where: "scope = 'org:' || ?1" },
  { table: PASSES_AT, where: 'org_id = ?1' },
  inOrg('signing_identities'),
  inOrg('credentials'),
  {
    table: 'magic_links',
    where: 'invitation_id IN (SELECT id FROM org_invitations WHERE org_id = ?1)',
  },
  {
    table: 'org_invitation_setups',
    where: 'invitation_id IN (SELECT id FROM org_invitations WHERE org_id = ?1)',
  },
  inOrg('org_memberships'),
  inOrg('org_invitations'),
  inOrg('template_release_reissues'),
  [
    {
      table: 'template_approvals',
      where: 'candidate_id IN (SELECT id FROM template_candidates WHERE org_id = ?1)',
    },
    inOrg('template_releases'),
    inOrg('wallet_provider_projection_evidence'),
    inOrg('wallet_provider_projection_evidence_history'),
    inOrg('template_candidates'),
    inOrg('wallet_samsung_tombstones'),
    {
      table: 'wallet_google_callback_replays',
      where: 'account_id IN (SELECT id FROM wallet_provider_accounts WHERE org_id = ?1)',
    },
    inOrg('wallet_enrolment_events'),
    inOrg('wallet_provider_account_events'),
    inOrg('wallet_provider_credentials'),
    { table: 'wallet_credential_checks', where: walletCredentialsOf('credential_id') },
    { table: 'wallet_credential_events', where: walletCredentialsOf('credential_id') },
    inOrg('wallet_provider_accounts'),
    { table: 'wallet_credential_versions', where: walletCredentialsOf('credential_id') },
    inOrg('wallet_credentials'),
  ],
  { table: 'template_version_extra_sets', where: templatesOf },
  { table: 'template_version_extras', where: templatesOf },
  { table: 'template_version_hashes', where: templatesOf },
  inOrg('templates'),
];

/** The stub: rows a purge leaves, each with the reason. The org row itself is scrubbed, never deleted. */
export const PURGE_KEEP: Readonly<Record<string, string>> = {
  orgs: 'the stub: id, slug and status stay so the slug cannot be reused and the history has an anchor',
  audit_log: 'kept for retention.auditDays; the audit retention job removes it',
  retention_receipts: 'deletion evidence: counts and a digest, never content',
  retention_receipt_anchors: 'the anchor of the receipt chain',
  retention_holds: 'a hold cannot be deleted while its org exists; released before a purge starts',
  pass_credential_tombstones: 'revocation evidence: refs only, no personal data',
  identity_handles: 'a handle is reserved forever: no reuse after a purge',
  wallet_google_issuers:
    'an issuer claim is permanent: no reuse after a purge without proof of ownership',
  org_entitlements:
    'the stub keeps its plan row: a trigger refuses deleting it while the org exists',
  developer_sandboxes:
    'the one-per-person record: ids and times only, so a closed sandbox is not made again; a trigger refuses deleting it',
};

/** Tables with no tenant rows. The authority tables (grants live inside one batch and are swept) count as well. */
export const PURGE_NOT_TENANT: Readonly<Record<string, string>> = {
  apns_keys: 'platform push key',
  wallet_sa_keys: 'platform service-account key inventory',
  auth_identities: 'user sign-in',
  authority_grant_leaks: 'grant bookkeeping',
  counters: 'rate-limit windows',
  console_email_grace: 'users who keep the console by email until the cutover',
  credential_ref_keyset: 'platform keyset',
  wallet_reissue_steps: 'reissue continuation dedupe, no tenant column, purged after 3 days',
  oidc_flows: 'sign-in flows',
  platform_invitation_setups: 'platform invitation signup token ids, no org',
  platform_invitations: 'platform invitations to Polaris ID groups, no org',
  platform_role_grants: 'platform admin grants of developer or support, no org',
  pass_transfer_asset_gc: 'retired storage keys, collected by the transfer asset sweep',
  idp_dirty: 'Polaris ID drain queue, keyed by subject',
  idp_directory_groups: 'Polaris ID SCIM mirror: opaque ids and flags',
  idp_directory_users: 'Polaris ID SCIM mirror: opaque ids and flags',
  idp_drift: 'Polaris ID differences by subject and target',
  idp_group_members: 'Polaris ID group members by subject, no org',
  idp_groups: 'Polaris ID custom groups, platform level',
  idp_target_state: 'Polaris ID projection cache by subject and target',
  entitlement_preset_meta: 'platform plan presets',
  entitlement_presets: 'platform plan presets',
  nfc_tag_systems: 'platform tag system registry',
  retention_platform_rev: 'platform setting revision',
  retired_api_key_ids: 'retired ids, never reused',
  retired_scanner_ids: 'retired ids, never reused',
  retired_session_ids: 'retired ids, never reused',
  sessions: 'user sessions, not org data',
  signing_identity_revision_sequence: 'platform sequence',
  status_incidents: 'platform incident notes for the public status page',
  template_version_tombstones: 'retired ids, never reused',
  user_emails: 'user accounts',
  users: 'user accounts',
  wallet_logs: 'platform device log posts',
  wallet_samsung_auth_replays: 'replay guard of the platform callback',
};

/**
 * R2 prefixes that belong to one org: prints, branding, template files, pass import sheets, exports and member
 * photos. Pass files go with the pass rows, staged template uploads by upload id (`purgeUploads`).
 */
export const orgPrefixes = (orgId: string): string[] => [
  `prints/${orgId}/`,
  `orgs/${orgId}/`,
  `templates/${orgId}/`,
  `uploads/pass-imports/${orgId}/`,
  `exports/${orgId}/`,
  `member-photos/${orgId}/`,
];
