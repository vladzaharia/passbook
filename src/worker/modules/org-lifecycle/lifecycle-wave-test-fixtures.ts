import { run } from '../../platform/db.ts';
import type { RetentionKit } from '../retention/retention-test-fixtures.ts';

/** One row in each table wave A added to an org, so a purge and an export meet every one of them. */
export async function seedWaveTables(
  kit: RetentionKit['kit'],
  o: { orgId: string; label: string; passId: string; scannerId: string },
): Promise<void> {
  const { env, clock, fx } = kit;
  const { orgId, label, passId, scannerId } = o;
  const now = clock.now();
  const bytes = (n: number) => new Uint8Array(n).fill(9);
  const hex = (s: string) => s.padEnd(64, '0');
  await run(
    env.DB,
    `INSERT INTO roll_calls (id, org_id, mode, scope_key, places, snapshot, started_by, started_at)
     VALUES (?, ?, 'live', 'org', '[]', '[]', 'system', 1)`,
    [`call-${label}`, orgId],
  );
  await run(
    env.DB,
    `INSERT INTO roll_call_marks (roll_call_id, pass_id, org_id, mode, status, by_name, marked_at)
     VALUES (?, ?, ?, 'live', 'present', 'Marker', 1)`,
    [`call-${label}`, passId, orgId],
  );
  const group = fx.ids.id();
  const member = fx.ids.id();
  for (const [id, key] of [
    [group, 'g'],
    [member, 'm'],
  ] as const)
    await run(
      env.DB,
      `INSERT INTO scans (id, org_id, mode, pass_id, actor_type, actor_id, actor_key, idempotency_key, request_hash, method, at)
       VALUES (?, ?, 'live', ?, 'system', 'sys', ?, ?, 'h', 'camera', ?)`,
      [id, orgId, passId, `${key}-${label}`, `${key}i-${label}`, now],
    );
  await run(
    env.DB,
    'INSERT INTO scan_group_members (group_scan_id, scan_id, org_id) VALUES (?, ?, ?)',
    [group, member, orgId],
  );
  await run(
    env.DB,
    `INSERT INTO scan_offline_reads (id, pass_id, actor_key, idempotency_key, org_id, mode, scanner_id, door, outcome,
       client_ts, recorded_ts, synced_at) VALUES (?, ?, ?, ?, ?, 'live', ?, 'listed', 'ok', 1, 1, 1)`,
    [`offline-${label}`, passId, `a-${label}`, `o-${label}`, orgId, scannerId],
  );
  await run(
    env.DB,
    'INSERT INTO scan_offline_state (scanner_id, org_id, online_at) VALUES (?, ?, 1)',
    [scannerId, orgId],
  );
  await run(
    env.DB,
    `INSERT INTO scan_session_changes (session_id, org_id, at, status, mode, prev_status, prev_mode)
     VALUES (?, ?, 1, 'active', 'online', 'paused', 'online')`,
    [`session-${label}`, orgId],
  );
  const type = `type-${label}`;
  await run(
    env.DB,
    `INSERT INTO nfc_tag_types (id, org_id, name, system, use, created_at, created_by, updated_at)
     VALUES (?, ?, 'Door tag', 'sun', 'door', 1, 'system', 1)`,
    [type, orgId],
  );
  const keyset = `keyset-${label}`;
  await run(
    env.DB,
    `INSERT INTO nfc_tag_keysets (id, org_id, mode, name, slug, diversify, type_id, created_at, created_by)
     VALUES (?, ?, 'live', 'Keys', ?, 0, ?, 1, 'system')`,
    [
      keyset,
      orgId,
      fx.ids
        .id()
        .replace(/[^a-z0-9]/g, '')
        .slice(-8),
      type,
    ],
  );
  await run(
    env.DB,
    `INSERT INTO nfc_tag_keys (id, keyset_id, version, kek_version, iv, wrapped_dek, ciphertext, state, created_at)
     VALUES (?, ?, 1, 1, ?, ?, ?, 'active', 1)`,
    [`key-${label}`, keyset, bytes(12), bytes(60), bytes(48)],
  );
  await run(
    env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, created_at)
     VALUES (?, ?, 'live', ?, 'uid', NULL, 'AB12', 1)`,
    [`tag-${label}`, orgId, hex('ab12')],
  );
  await run(
    env.DB,
    `INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, type_id, hint, created_at)
     VALUES (?, ?, 'live', ?, 'sun', ?, 'CD34', 1)`,
    [`sun-tag-${label}`, orgId, hex('cd34'), type],
  );
  await run(
    env.DB,
    'INSERT INTO nfc_tag_sun (tag_id, keyset_id, key_version, ctr, ctr_at) VALUES (?, ?, 1, 0, 1)',
    [`sun-tag-${label}`, keyset],
  );
  await run(
    env.DB,
    `INSERT INTO scanning_sessions (id, org_id, mode, name, settings, time_zone, created_at, updated_at, setup_template_id)
     VALUES (?, ?, 'live', 'Door', '{}', 'UTC', 1, 1, ?)`,
    [`setup-session-${label}`, orgId, `tpl-${label}`],
  );
  await run(
    env.DB,
    `INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, version, updated_at)
     VALUES (?, ?, ?, 'sha', 1, 1, 'v1', 1)`,
    [passId, orgId, `member-photos/${orgId}/${passId}/photo.png`],
  );
  await run(
    env.DB,
    `INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'scan.maxDevices', '5', 1)`,
    [orgId],
  );
  await run(
    env.DB,
    `INSERT INTO idempotent_requests (org_id, mode, principal, operation, key, request_hash, created_at, expires_at)
     VALUES (?, 'live', 'key:k', 'POST /passes', ?, 'h', 1, ?)`,
    [orgId, `v2-${label}`, now + 86_400_000],
  );
}
