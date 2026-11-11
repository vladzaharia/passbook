import { EPOCH_TABLES } from './authority-columns.ts';

/** A declared foreign key from an org-less child to a parent that carries the org (and mode). */
export interface Edge {
  /** Column of the child. It is a parent key, so it is never `set`; inserts take it from the parent row. */
  column: string;
  parent: string;
  key: string;
}

/** How a guarded table is tied to a grant's org and mode (authority-epochs.md Appendix B). */
export interface TableScope {
  /** Column holding the org; `scope` for settings (`org:<id>`), `id` for orgs. */
  org: 'org_id' | 'id' | 'scope' | null;
  /** The live/test column. Absent for tables without one; connections.mode is a sync mode, not this. */
  mode?: 'mode';
  /** Org-less child: reached only through these foreign keys (`g.joined`, `g.insertJoined`). The first is the default. */
  edges?: Edge[];
  /** Org-less and parentless: only a platform grant writes it, and only `columns` may change. */
  platform?: { columns: string[] };
  /** The fixed `ON CONFLICT` target of `g.upsert`. The builder adds the tenant guard to `DO UPDATE`. */
  conflict?: string[];
  /** The column naming a pass. A holder grant writes only tables that declare it, and only its own pass's rows. */
  pass?: 'id' | 'pass_id';
}

const edge = (column: string, parent: string, key = 'id'): Edge => ({ column, parent, key });

/**
 * Every table a tenant write must go through a grant for. A null `org` marks a table with no org
 * column of its own: a child is written through its declared edges, `users` and `sessions` only by a
 * platform grant.
 */
export const GUARDED_TABLES: Readonly<Record<string, TableScope>> = {
  orgs: { org: 'id' },
  settings: { org: 'scope', conflict: ['scope', 'key'] },
  org_memberships: { org: 'org_id' },
  org_invitations: { org: 'org_id' },
  api_keys: { org: 'org_id', mode: 'mode' },
  users: { org: null, platform: { columns: ['status'] } },
  sessions: { org: null, platform: { columns: ['revoked_at'] } },
  passes: { org: 'org_id', mode: 'mode', pass: 'id' },
  pass_assets: { org: null, edges: [edge('pass_id', 'passes')], pass: 'pass_id' },
  pass_credential_transfers: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  pass_credential_tombstones: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  pass_issuance_deliveries: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  templates: { org: 'org_id' },
  template_candidates: { org: 'org_id', mode: 'mode' },
  template_approvals: { org: null, edges: [edge('candidate_id', 'template_candidates')] },
  template_releases: { org: 'org_id', mode: 'mode' },
  outbox: { org: 'org_id', pass: 'pass_id' },
  bundles: { org: 'org_id', mode: 'mode' },
  bundle_passes: {
    org: null,
    edges: [edge('bundle_id', 'bundles'), edge('pass_id', 'passes')],
    pass: 'pass_id',
  },
  captured_emails: { org: 'org_id' },
  sandbox_forwards: { org: 'org_id' },
  connections: { org: 'org_id' },
  connection_runs: { org: null, edges: [edge('connection_id', 'connections')] },
  connection_webhook_retention: { org: 'org_id' },
  connection_webhook_items: {
    org: null,
    edges: [edge('retention_id', 'connection_webhook_retention')],
  },
  scans: { org: 'org_id', mode: 'mode', conflict: ['actor_key', 'idempotency_key'] },
  scan_gates: { org: 'org_id', mode: 'mode', conflict: ['pass_id', 'action_id', 'scope'] },
  scan_presence: { org: 'org_id', conflict: ['pass_id', 'scope'] },
  scan_staff: { org: 'org_id' },
  scan_events: { org: 'org_id', mode: 'mode' },
  scan_event_templates: { org: null, edges: [edge('event_id', 'scan_events')] },
  scanners: { org: 'org_id', mode: 'mode' },
  scanning_sessions: { org: 'org_id', mode: 'mode' },
  scanning_devices: { org: 'org_id', mode: 'mode' },
  pass_events: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  // Its triggers write passes.image_generation, so a part could reach a pass of another tenant.
  member_photos: { org: 'org_id', pass: 'pass_id' },
};

/** Tables only the triggers and `authority.ts` may write; raw SQL on them is a lint failure. */
export const AUTHORITY_TABLES = [
  'authority_grants',
  'template_release_heads',
  'retired_api_key_ids',
] as const;

/**
 * Columns a write may never name for a non-platform grant: the org column (`org_id`, `scope`, `id`)
 * and, for an `org_mode` grant, the mode column. The grant row supplies them.
 */
export function ownedColumns(t: TableScope, scope: 'org' | 'org_mode' | 'platform'): Set<string> {
  const owned = new Set<string>();
  if (scope === 'platform') return owned;
  if (t.org !== null) owned.add(t.org);
  if (scope === 'org_mode' && t.mode) owned.add(t.mode);
  return owned;
}

/**
 * Epoch columns are trigger-owned (Rule 3). A table whose bump trigger is still pending keeps an
 * app-written epoch (`connections.generation` until WP4).
 */
export function epochColumns(table: string): Set<string> {
  const e = EPOCH_TABLES.find((x) => x.table === table);
  return new Set(e && !e.bumpTriggerBy ? Object.keys(e.epochs) : []);
}

/** Tables a grant may only append to (`Grant.audit`): no UPDATE or DELETE through any grant statement. */
export const APPEND_ONLY_TABLES = ['audit_log'] as const;

/**
 * Unguarded tables whose triggers write a guarded table. An `include` part on one would reach the guarded
 * table through the trigger, so parts refuse them. Empty while `member_photos` is guarded; a test derives it
 * from the migrated schema.
 */
export const TRIGGER_WRITES_GUARDED: readonly string[] = [];

/**
 * Unguarded tables that carry an `org_id`, `mode` or `pass_id` column. An `include` write on one must tie
 * it to `{org}`, `{mode}` or `{pass}`. A test derives these lists from the migrated schema.
 */
export const ORG_BEARING_TABLES: ReadonlySet<string> = new Set([
  'credentials',
  'signing_identities',
  'idempotency_keys',
  'template_imports',
  'workflow_runs',
  'broadcasts',
  'vas_keys',
  'pass_check_in',
  'scanner_setups',
  'template_release_reissues',
  'workflow_release_snapshots',
  'connection_webhook_legacy_sources',
  'connection_webhook_replays',
  'wallet_provider_accounts',
  'wallet_provider_credentials',
  'wallet_provider_account_events',
  'wallet_provider_instances',
  'wallet_samsung_callback_receipts',
  'wallet_google_callback_receipts',
  'wallet_samsung_tombstones',
  'wallet_provider_projection_evidence',
  'wallet_provider_projection_evidence_history',
  'scan_retention_proofs',
  'scan_retention_event_transitions',
  'scan_retention_delete_intents',
  'scan_retained_gates',
  'pass_holder_reissue_required',
  'scan_asset_grant_provenance',
]);
export const MODE_BEARING_TABLES: ReadonlySet<string> = new Set([
  'broadcasts',
  'scanner_setups',
  'template_release_reissues',
  'workflow_release_snapshots',
  'wallet_provider_accounts',
  'wallet_provider_credentials',
  'wallet_provider_account_events',
  'wallet_provider_instances',
  'wallet_samsung_callback_receipts',
  'wallet_google_callback_receipts',
  'wallet_samsung_tombstones',
  'wallet_provider_projection_evidence',
  'wallet_provider_projection_evidence_history',
  'scan_retention_proofs',
  'scan_retention_event_transitions',
  'scan_retention_delete_intents',
  'scan_retained_gates',
  'pass_holder_reissue_required',
  'scan_asset_grant_provenance',
]);
/**
 * Unguarded tables a holder grant may also write although they carry no `pass_id`: the column that names
 * its pass, or `transfer`, pinned through the transfer row (`pass_credential_transfers.pass_id`).
 */
export const HOLDER_PART_PINS: Readonly<Record<string, { column: string; via?: 'transfer' }>> = {
  pass_credential_transfer_payloads: { column: 'transfer_id', via: 'transfer' },
  pass_transfer_asset_gc: { column: 'source_pass_id' },
};

export const PASS_BEARING_TABLES: ReadonlySet<string> = new Set([
  'pass_versions',
  'pass_attach_blocks',
  'registrations',
  'revisions',
  'pass_personalizations',
  'broadcast_items',
  'pass_check_in',
  'sandbox_forward_passes',
  'wallet_provider_instances',
  'wallet_provider_pass_authority',
  'pass_holder_reissue_required',
  'pass_transfer_asset_candidates',
  'pass_transfer_asset_recoveries',
  'pass_transfer_asset_uploads',
]);
