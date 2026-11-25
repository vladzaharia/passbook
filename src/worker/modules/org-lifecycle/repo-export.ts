import { all } from '../../platform/db.ts';

/**
 * One NDJSON file of the archive. `select` binds the org as `?1`, the last rowid as `?2` and the page size as
 * `?3`. Columns are listed by hand: secrets (tokens, hashes, keys, sealed copies, PINs) never leave.
 */
export interface ExportEntity {
  name: string;
  select: string;
}

const page = (cols: string, from: string, where: string, rowid: string) =>
  `SELECT ${rowid} AS rid, ${cols} FROM ${from} WHERE ${where} AND ${rowid} > ?2 ORDER BY ${rowid} LIMIT ?3`;
const inOrg = (name: string, cols: string, table = name, extra = '') =>
  ({ name, select: page(cols, table, `org_id = ?1${extra}`, 'rowid') }) satisfies ExportEntity;

/** For WITHOUT ROWID tables: the cursor is the row's place in primary key order. */
const keyed = (cols: string, from: string, where: string, order: string) =>
  `SELECT rid, ${cols} FROM (SELECT ROW_NUMBER() OVER (ORDER BY ${order}) AS rid, ${cols} FROM ${from} WHERE ${where}) WHERE rid > ?2 ORDER BY rid LIMIT ?3`;

export const EXPORT_ENTITIES: readonly ExportEntity[] = [
  {
    name: 'org',
    select: page(
      'id, slug, name, status, branding, created_at, closed_at',
      'orgs',
      'id = ?1',
      'rowid',
    ),
  },
  {
    name: 'members',
    select: page(
      "m.id, m.user_id, u.name, COALESCE((SELECT i.email FROM org_invitations i WHERE i.id = m.invitation_id), 'Account') AS email, m.roles, m.created_at, m.revoked_at",
      'org_memberships m JOIN users u ON u.id = m.user_id',
      'm.org_id = ?1',
      'm.rowid',
    ),
  },
  inOrg(
    'passes',
    'id, mode, serial, template_id, template_version, display_title, display_subtitle, external_id, holder_email, status, personalization, field_sources, version, created_at, modified_at, removed_at, deleted_at',
  ),
  inOrg(
    'templates',
    'id, slug, name, description, origin, active_version, status, styles, created_at, updated_at',
  ),
  {
    name: 'template_versions',
    select: page(
      'v.template_id, v.version, v.manifest, v.pass_json, v.assets, v.created_at',
      'template_versions v',
      'v.template_id IN (SELECT id FROM templates WHERE org_id = ?1)',
      'v.rowid',
    ),
  },
  inOrg(
    'connections',
    'id, connector_type, name, config, mapping, mode, enabled, auto_create, auto_email, on_missing, created_at, updated_at',
  ),
  inOrg(
    'webhook_endpoints',
    'id, mode, url, description, event_types, template_ids, status, created_at, updated_at',
  ),
  inOrg('bundles', 'id, mode, name, holder_email, created_at'),
  {
    name: 'bundle_passes',
    select: page(
      'bp.bundle_id, bp.pass_id, bp.position',
      'bundle_passes bp JOIN bundles b ON b.id = bp.bundle_id',
      'b.org_id = ?1',
      'bp.rowid',
    ),
  },
  inOrg(
    'scan_events',
    'id, mode, name, opens_at, closes_at, time_zone, capacity, setup_key, created_at, archived_at',
  ),
  inOrg(
    'scanning_sessions',
    'id, mode, name, status, accepts, settings, time_zone, hours, hold, setup_template_id, created_at, updated_at, created_by',
  ),
  inOrg('scan_zones', 'id, key, name, parent_id, time_zone, capacity, created_at, archived_at'),
  inOrg('scanners', 'id, mode, kind, name, event_id, paired_at, created_at, revoked_at'),
  inOrg('scan_staff', 'id, name, role, created_at, disabled_at'),
  inOrg(
    'scans',
    'id, mode, pass_id, template_id, scanner_id, event_id, actor_type, actor_id, staff_id, method, state, outcome, reason, action_kind, direction, amount, at, zone_id, session_id',
  ),
  inOrg('scan_group_members', 'group_scan_id, scan_id'),
  inOrg(
    'roll_calls',
    'id, mode, scope_key, places, snapshot, started_by, started_by_id, scanner_id, started_at, ended_at, ended_by, rev',
  ),
  inOrg(
    'roll_call_marks',
    'roll_call_id, pass_id, mode, status, by_name, scanner_id, late, exit_scan_id, marked_at',
  ),
  // Tag keys and counters never leave; `tag_ref` is a keyed hash of the tag, so only its 4-character hint does.
  inOrg(
    'nfc_tags',
    'id, mode, system, type_id, hint, label, status, status_at, created_at, last_seen_at, lost_at, lost_by',
  ),
  inOrg(
    'nfc_tag_types',
    'id, name, system, use, scopes, per_pass, binding_days, confirm, typed, version, created_at, created_by, updated_at, archived_at',
  ),
  inOrg(
    'nfc_tag_keysets',
    'id, mode, name, slug, diversify, type_id, created_at, created_by, disabled_at',
  ),
  {
    name: 'nfc_tag_type_templates',
    select: page(
      'tt.type_id, tt.template_id',
      'nfc_tag_type_templates tt JOIN nfc_tag_types t ON t.id = tt.type_id',
      't.org_id = ?1',
      'tt.rowid',
    ),
  },
  {
    name: 'tag_bindings',
    select: page(
      'b.id, b.tag_id, b.scope, b.pass_id, b.user_id, b.source, b.bound_at, b.bound_by_type, b.bound_by, b.scanner_id, b.ended_at, b.ended_by_type, b.ended_by, b.end_cause',
      'tag_bindings b JOIN nfc_tags t ON t.id = b.tag_id',
      't.org_id = ?1',
      'b.rowid',
    ),
  },
  inOrg('member_photos', 'pass_id, include_in_pass, size, version, updated_at'),
  inOrg('org_entitlements', 'preset, trial_ends_at, revision, updated_at, updated_by'),
  inOrg('org_entitlement_overrides', 'key, value, note, expires_at, updated_at, updated_by'),
  inOrg(
    'broadcasts',
    'id, mode, kind, name, state, target, patch, notify, at, clear_after, expect, parent_id, targeted, error_code, created_by_type, created_by_id, created_at, started_at, finished_at, checked_at, rule_id, window_key',
  ),
  {
    name: 'broadcast_items',
    select: keyed(
      'broadcast_id, pass_id, outcome, silent',
      'broadcast_items',
      'broadcast_id IN (SELECT id FROM broadcasts WHERE org_id = ?1)',
      'broadcast_id, pass_id',
    ),
  },
  inOrg(
    'message_rules',
    'id, mode, name, state, paused_code, template_ids, match, anchor_kind, anchor_input, offset_amount, offset_unit, offset_when, yearly, send_at, time_zone, message, clear_after, next_check_at, checked_at, last_broadcast_id, sent, skipped, version, created_by_type, created_by_id, created_at, edited_at',
  ),
  {
    name: 'message_rule_fires',
    select: keyed(
      'rule_id, pass_id, occurrence, mode, broadcast_id, fired_at',
      'message_rule_fires',
      'org_id = ?1',
      'rule_id, pass_id, occurrence',
    ),
  },
  {
    name: 'pass_channels',
    select: keyed(
      'pass_id, mode, template_id, channel, override, retired_at, retired_cause, revision, set_by, set_at',
      'pass_channels',
      'org_id = ?1',
      'pass_id, channel',
    ),
  },
  {
    name: 'pass_channel_copies',
    select: keyed(
      'pass_id, mode, channel, copy_at',
      'pass_channel_copies',
      'org_id = ?1',
      'pass_id, channel',
    ),
  },
  inOrg('pass_check_in', 'pass_id, rules, updated_at'),
  {
    name: 'template_channel_policies',
    select: keyed(
      'mode, template_id, channels, revision, updated_by, updated_at',
      'template_channel_policies',
      'org_id = ?1',
      'mode, template_id',
    ),
  },
  {
    name: 'scan_event_templates',
    select: page(
      'et.event_id, et.template_id',
      'scan_event_templates et JOIN scan_events e ON e.id = et.event_id',
      'e.org_id = ?1',
      'et.rowid',
    ),
  },
  {
    name: 'scanner_templates',
    select: page(
      'st.scanner_id, st.template_id',
      'scanner_templates st JOIN scanners s ON s.id = st.scanner_id',
      's.org_id = ?1',
      'st.rowid',
    ),
  },
  {
    name: 'scanning_session_zones',
    select: keyed(
      'session_id, zone_id, sort',
      'scanning_session_zones',
      'session_id IN (SELECT id FROM scanning_sessions WHERE org_id = ?1)',
      'session_id, zone_id',
    ),
  },
  inOrg(
    'pass_notes',
    'id, mode, pass_id, body, author_name, author_staff_id, scanner_id, created_at',
  ),
  inOrg('pass_events', 'id, mode, pass_id, kind, device, actor_type, actor_id, data, at'),
  inOrg(
    'audit_log',
    'id, at, actor_type, actor_id, action, target_type, target_id, request_id, detail',
  ),
];

export type ExportRowOut = Record<string, unknown>;

/** One page after `after` (a rowid, 0 first). `last` is the rowid to continue from, null for an empty page. */
export async function exportPage(
  db: D1Database,
  entity: ExportEntity,
  orgId: string,
  after: number,
  limit: number,
): Promise<{ rows: ExportRowOut[]; last: number | null }> {
  const rows = await all<ExportRowOut & { rid: number }>(db, entity.select, [orgId, after, limit]);
  const last = rows.at(-1)?.rid ?? null;
  return { rows: rows.map(({ rid: _rid, ...rest }) => rest), last };
}
