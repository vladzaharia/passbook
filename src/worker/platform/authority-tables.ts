import { EPOCH_TABLES } from './authority-columns.ts';
import { CREATOR_ORG_PURPOSE, PERSONAL_ORG_PURPOSE } from './authority-personal.ts';

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
  // The mark a new scan code needs (0099); written with the pass update, in the publish grant.
  scan_code_rotations: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  pass_issuance_deliveries: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  templates: { org: 'org_id' },
  template_candidates: { org: 'org_id', mode: 'mode' },
  template_approvals: { org: null, edges: [edge('candidate_id', 'template_candidates')] },
  template_releases: { org: 'org_id', mode: 'mode' },
  template_forks: { org: 'org_id' },
  template_fork_updates: { org: 'org_id' },
  template_version_bases: {
    org: null,
    edges: [edge('template_id', 'template_forks', 'template_id')],
  },
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
  connection_files: { org: 'org_id' },
  connection_ref_versions: { org: 'org_id', conflict: ['connection_id', 'ref'] },
  connection_webhook_retention: { org: 'org_id' },
  connection_webhook_items: {
    org: null,
    edges: [edge('retention_id', 'connection_webhook_retention')],
  },
  // Written once with its key (`createKey`); the migration's triggers refuse any later change.
  api_key_terminals: {
    org: null,
    edges: [edge('key_id', 'api_keys'), edge('scanner_id', 'scanners')],
  },
  // Template and pass-style restrictions, written once with the key (migration 0142 refuses any later change).
  api_key_resources: { org: null, edges: [edge('key_id', 'api_keys')] },
  scans: { org: 'org_id', mode: 'mode', conflict: ['actor_key', 'idempotency_key'] },
  scan_gates: { org: 'org_id', mode: 'mode', conflict: ['pass_id', 'action_id', 'scope'] },
  // `mode` from 0074: the pass decides it (insert triggers). No holder writes, so no `pass` pin.
  scan_presence: { org: 'org_id', mode: 'mode', conflict: ['pass_id', 'scope'] },
  scan_staff: { org: 'org_id' },
  scan_events: { org: 'org_id', mode: 'mode' },
  scan_event_templates: { org: null, edges: [edge('event_id', 'scan_events')] },
  scanners: { org: 'org_id', mode: 'mode' },
  // Its triggers move scanners.config_epoch: written only through a scanner of the grant's tenant.
  scanner_templates: { org: null, edges: [edge('scanner_id', 'scanners')] },
  scanning_sessions: { org: 'org_id', mode: 'mode' },
  // Org data, not per mode: a test scanner opens the same pool.
  scan_zones: { org: 'org_id' },
  // Its triggers move scanning_sessions.config_epoch. Both parents must be in the grant's tenant.
  scanning_session_zones: {
    org: null,
    edges: [edge('session_id', 'scanning_sessions'), edge('zone_id', 'scan_zones')],
  },
  scanning_devices: { org: 'org_id', mode: 'mode' },
  // In now ordering: only raised (`inc`), in the batch that changes the place.
  scan_place_revs: { org: 'org_id', mode: 'mode', conflict: ['org_id', 'mode', 'place'] },
  pass_events: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  // Join links (0090). Written by the admin grant; the sealed copy is an org-bearing part (below).
  join_links: { org: 'org_id', mode: 'mode' },
  // The ledger a join grant appends to with its pass. Its triggers hold org, mode and generation to the link.
  join_issues: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  // The permanent mark of a card a join link made: inserted with the ledger row, never changed or deleted.
  join_marks: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  // Its triggers write passes.image_generation, so a part could reach a pass of another tenant.
  member_photos: { org: 'org_id', pass: 'pass_id' },
  nfc_tags: { org: 'org_id', mode: 'mode', conflict: ['org_id', 'mode', 'tag_ref'] },
  // Its triggers check that tag and pass share the tenant and that a user binding is anchored on a pass the
  // user owns; written only through both parents. `pass` lets a holder grant end a binding on its own pass.
  tag_bindings: {
    org: null,
    edges: [edge('tag_id', 'nfc_tags'), edge('pass_id', 'passes')],
    pass: 'pass_id',
  },
  nfc_tag_types: { org: 'org_id' },
  nfc_tag_type_templates: {
    org: null,
    edges: [edge('type_id', 'nfc_tag_types'), edge('template_id', 'templates')],
  },
  // Secure tag keys (0129): keys and per-tag counters hang off a keyset or tag; triggers hold them to one org and mode.
  nfc_tag_keysets: { org: 'org_id', mode: 'mode' },
  nfc_tag_keys: { org: null, edges: [edge('keyset_id', 'nfc_tag_keysets')] },
  nfc_tag_sun: { org: null, edges: [edge('tag_id', 'nfc_tags')] },
  // Outbound webhooks (0090): endpoints and secrets via grants, delivery bookkeeping via the raw-write allowlist, event_feed by the pass_events trigger.
  webhook_endpoints: { org: 'org_id', mode: 'mode' },
  webhook_endpoint_secrets: { org: 'org_id', mode: 'mode' },
  webhook_deliveries: { org: 'org_id', mode: 'mode', conflict: ['endpoint_id', 'event_seq'] },
  webhook_attempts: { org: 'org_id', mode: 'mode' },
  // The webhook tester (0158): stored requests of a capture endpoint, and the per-hour count that caps them.
  webhook_captures: { org: 'org_id', mode: 'mode' },
  webhook_capture_hours: { org: 'org_id' },
  event_feed: { org: 'org_id', mode: 'mode' },
  // A remote tag request: its triggers check scanner and pass share the tenant and that a user scope names the pass's owner.
  tag_enrollments: { org: 'org_id', mode: 'mode' },
  // Marks that let cron tokens.remac replace a MAC with a MAC (0069); only repo-pass-trusted.ts writes them.
  token_remac_marks: { org: null, edges: [edge('pass_id', 'passes')] },
  visitors: { org: 'org_id', mode: 'mode' },
  pass_imports: { org: 'org_id', mode: 'mode' },
  pass_import_rows: { org: null, edges: [edge('import_id', 'pass_imports')] },
  // Org data, not per mode: a plan made in Test works in Live.
  pass_import_mappings: { org: 'org_id', conflict: ['org_id', 'template_id'] },
  // The bundle counterpart (0087).
  bundle_remac_marks: { org: null, edges: [edge('bundle_id', 'bundles')] },
  // Trust pack (0101): floors ride the settings grant; holds by org:manage or a platform admin; receipts and anchors by platform jobs.
  retention_floors: { org: 'org_id', conflict: ['org_id', 'class'] },
  retention_holds: { org: 'org_id' },
  retention_receipts: { org: 'org_id' },
  retention_receipt_anchors: { org: 'org_id' },
  // Delivery channels (0109). Policy per template, override per pass; copy evidence is insert-once.
  template_channel_policies: {
    org: 'org_id',
    mode: 'mode',
    conflict: ['org_id', 'mode', 'template_id'],
  },
  // No `pass` pin: holder and join grants never write overrides.
  pass_channels: { org: 'org_id', mode: 'mode', conflict: ['pass_id', 'channel'] },
  pass_channel_copies: {
    org: 'org_id',
    mode: 'mode',
    pass: 'pass_id',
    conflict: ['pass_id', 'channel'],
  },
  // Channel apply (0114): one run per template save window; marks are its per-pass evidence and take the run's tenant.
  channel_apply_runs: { org: 'org_id', mode: 'mode' },
  channel_apply_marks: { org: null, edges: [edge('run_id', 'channel_apply_runs')] },
  // Printed tickets (0110): minted and voided through grants; the triggers void them with the pass.
  pass_prints: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  // Roll call (0122): the frozen list and each person's confirmation. Marks upsert by (call, pass).
  roll_calls: { org: 'org_id', mode: 'mode' },
  roll_call_marks: {
    org: 'org_id',
    mode: 'mode',
    conflict: ['roll_call_id', 'pass_id'],
  },
  // Staff notes (0145): written by a Desk scanner's grant. The pass pin is for the transfer's delete only; no holder flow inserts one.
  pass_notes: { org: 'org_id', mode: 'mode', pass: 'pass_id' },
  data_requests: { org: 'org_id' },
  data_request_passes: { org: null, edges: [edge('request_id', 'data_requests')] },
  // Wallet provider credentials (0112): a platform-scope row has a null org_id, so no org grant matches it; children take its tenant.
  wallet_credentials: { org: 'org_id', mode: 'mode' },
  wallet_credential_versions: { org: null, edges: [edge('credential_id', 'wallet_credentials')] },
  wallet_credential_events: { org: null, edges: [edge('credential_id', 'wallet_credentials')] },
  wallet_credential_checks: { org: null, edges: [edge('credential_id', 'wallet_credentials')] },
  // An enrolment's events (the account row itself is written by `include` parts, tied to {org} and {mode}).
  wallet_enrolment_events: { org: 'org_id', mode: 'mode' },
  org_entitlements: { org: 'org_id' },
  // A person's developer sandbox (0156): made once with its org, closed by the idle sweep; funnel columns are set once.
  developer_sandboxes: { org: 'org_id' },
  org_entitlement_overrides: { org: 'org_id', conflict: ['org_id', 'key'] },
  entitlement_preset_meta: {
    org: null,
    platform: {
      columns: ['label', 'is_plan', 'revision', 'updated_at', 'updated_by', 'previous_values'],
    },
  },
  entitlement_presets: { org: null, platform: { columns: ['value'] } },
};

/** The cron that retires one org's expired overrides and journals the change like a platform save (org scope: the grant pins the tenant). */
export const ENTITLEMENT_EXPIRY_PURPOSE = 'org.job.entitlement_expiry';

const KEYSET_PURPOSES = ['create', 'rotate', 'retire_key', 'revoke_key', 'disable'].map(
  (p) => `org_mode.nfc.keyset.${p}`,
);

/**
 * Guarded tables only the listed purposes may write, whatever the principal or the grant's `tables`. The
 * credential check job is the one writer of a check: no org_mode or platform.wallet.* grant inserts one.
 * Entitlements (0134) are platform-only (design-multi-tenancy.md section 2.2): an org never writes its own.
 */
export const RESTRICTED_TABLES: Readonly<Record<string, readonly string[]>> = {
  wallet_credential_checks: ['platform.job.wallet.credential_check'],
  org_entitlements: [
    'platform.org.create',
    PERSONAL_ORG_PURPOSE,
    CREATOR_ORG_PURPOSE,
    'platform.job.template_sync',
    'platform.job.developer_sandbox.create',
    'platform.org.entitlements_set',
    ENTITLEMENT_EXPIRY_PURPOSE,
  ],
  org_entitlement_overrides: ['platform.org.entitlements_set', ENTITLEMENT_EXPIRY_PURPOSE],
  entitlement_preset_meta: ['platform.entitlement_preset.update'],
  entitlement_presets: ['platform.entitlement_preset.update'],
  // Secure tag keys (0129): the five keyset purposes only (re-enrol and import write side rows, not keys).
  nfc_tag_keysets: KEYSET_PURPOSES,
  nfc_tag_keys: KEYSET_PURPOSES,
};

/**
 * Restricted purposes that may only insert into a table (no update, delete or upsert). Baked-template
 * sync creates the platform org with its `legacy` row, and must never change an org's entitlements.
 */
const INSERT_ONLY_PURPOSES: Readonly<Record<string, readonly string[]>> = {
  org_entitlements: [
    'platform.job.template_sync',
    'platform.job.developer_sandbox.create',
    'platform.org.create',
    PERSONAL_ORG_PURPOSE,
    CREATOR_ORG_PURPOSE,
  ],
};

/** Why `purpose` may not write `table` this way (`op`), or null: the restricted-table and insert-only rules. */
export function restrictedWriteRefusal(
  table: string,
  purpose: string,
  op: 'insert' | 'change',
): string | null {
  const name = table.toLowerCase();
  const only = RESTRICTED_TABLES[name];
  if (only && !only.includes(purpose)) return `${table} is written only by ${only.join(' or ')}.`;
  if (op === 'change' && INSERT_ONLY_PURPOSES[name]?.includes(purpose))
    return `${purpose} only inserts into ${table}.`;
  return null;
}

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
 * table through the trigger, so parts refuse them. `request_log`: its insert trigger stamps the guarded
 * `developer_sandboxes` progress columns (0176). A test derives the list from the migrated schema.
 */
export const TRIGGER_WRITES_GUARDED: readonly string[] = ['request_log'];

export {
  MODE_BEARING_TABLES,
  ORG_BEARING_TABLES,
  PASS_BEARING_TABLES,
} from './authority-bearing-tables.ts';
/**
 * Unguarded tables a holder grant may also write although they carry no `pass_id`: the column that names
 * its pass, or `transfer`, pinned through the transfer row (`pass_credential_transfers.pass_id`).
 */
export const HOLDER_PART_PINS: Readonly<Record<string, { column: string; via?: 'transfer' }>> = {
  pass_credential_transfer_payloads: { column: 'transfer_id', via: 'transfer' },
  pass_transfer_asset_gc: { column: 'source_pass_id' },
};
