// What production holds that the base seed (legacy-seed.ts) lacks, as the old Worker (c25b9c09) wrote it.
import { sha256Hex } from '../../src/worker/platform/ids.ts';
import { TEST_NOW } from '../helpers/index.ts';
import { AT, type Legacy, q } from './legacy-seed.ts';

const RECENT = TEST_NOW - 60_000;
/** The cookie of the legacy session; its id_hash is the SHA-256 of this value. */
export const LEGACY_COOKIE = 'legacy-session-cookie-0123456789abcdef';
export const LEGACY_PHOTO_KEY = 'photos/org-a/prod-live-1.jpg';
export const LEGACY_ASSET_KEY = 'passes/prod-live-1/thumbnail.png';

/** The `pass_events.data` of the old ledger (src/worker/modules/scan/ledger.ts): ids, enums and numbers. */
const ledger = (scanId: string, outcome: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({
    scanId,
    actionId: 'enter',
    actionKind: 'check_in',
    outcome,
    reason: null,
    method: 'camera',
    version: 1,
    eventId: null,
    scannerId: 'sc-uploaded-active',
    scannerName: 'Door uploaded-active',
    staffId: null,
    approvedBy: null,
    override: false,
    offline: false,
    notified: false,
    ...over,
  });

export async function seedProduction(db: D1Database, bucket: R2Bucket, legacy: Legacy) {
  const starter = legacy.baked[0]?.template;
  if (!starter) throw new Error('no baked starter');
  const templateId = legacy.templateIds['baked-unassigned'];
  const stmts: string[] = [];
  const add = (sql: string) => stmts.push(sql);
  const pass = (id: string, org: string, extra: Record<string, string | number | null> = {}) => {
    const row: Record<string, string | number | null> = {
      id,
      org_id: org,
      identity_id: 'platform',
      serial: `serial-${id}`,
      template_id: templateId,
      template_version: starter.version,
      auth_token: `auth-${id}`,
      download_token: `dl-${id}`,
      web_service_url: 'https://wallet.plrs.im/v1',
      personalization: '{}',
      display_title: id,
      status: 'active',
      version: 1,
      object_key: `passes/${id}/1.pkpass`,
      modified_at: AT,
      created_at: AT,
      mode: 'live',
      pending_pass_json: JSON.stringify({
        serialNumber: `serial-${id}`,
        authenticationToken: `auth-${id}`,
        passTypeIdentifier: 'pass.im.plrs.wallet',
      }),
      ...extra,
    };
    add(
      `INSERT INTO passes (${Object.keys(row).join(', ')}) VALUES (${Object.values(row).map(q).join(', ')})`,
    );
  };

  // Orgs: suspended, and an org with its own signing identity.
  add(`INSERT INTO orgs (id, slug, name, status, branding, created_at, updated_at) VALUES
    ('org-susp', 'org-susp', 'Suspended', 'suspended', '{}', ${AT}, ${AT})`);
  add(`INSERT INTO credentials (id, org_id, kind, kek_version, iv, wrapped_dek, ciphertext, fingerprint, created_at)
    VALUES ('cred-own', 'org-a', 'pass_signer', 1, X'0102', X'0304', X'0506', 'fp-own', ${AT})`);
  add(`INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source, credential_id,
      cert_pem, cert_sha256, not_before, not_after, is_default, created_at) VALUES ('ident-own', 'org-a', 'Org A own',
      'pass.org.a.own', 'TEAMA00000', 'db', 'cred-own', 'PEM', ${q('c'.repeat(64))}, ${AT}, ${AT + 9e10}, 0, ${AT})`);

  // Passes: live (with ledger, assets, photo, queue), test, removed, half-removed, suspended org, own identity.
  pass('prod-live-1', 'org-a', { holder_email: 'holder@example.com' });
  pass('prod-live-2', 'org-a');
  pass('prod-test-1', 'org-a', { mode: 'test' });
  pass('prod-test-2', 'org-b', { mode: 'test' });
  pass('prod-susp-1', 'org-susp', { holder_email: 'susp@example.com' });
  pass('prod-own-1', 'org-a', { identity_id: 'ident-own' });
  // Removed: voided, with the prior status and message. Half-removed: removed_at set, the voided publish never ran.
  const removed = {
    removed_at: AT + 1000,
    removal_prior_status: 'active',
    removal_message: 'Removed',
  };
  pass('prod-removed', 'org-a', { ...removed, status: 'voided' });
  pass('prod-half-removed', 'org-a', removed);

  // Version history: three published versions, each with the device token in the stored pass.json.
  pass('prod-history', 'org-a');
  for (const v of [2, 3])
    add(`UPDATE passes SET version = ${v}, object_key = 'passes/prod-history/${v}.pkpass', pending_cause = 'admin',
      pending_pass_json = ${q(JSON.stringify({ serialNumber: 'serial-prod-history', authenticationToken: 'auth-prod-history', v }))}
      WHERE id = 'prod-history'`);

  // Connection with items, webhook inbox and runs.
  add(`INSERT INTO connections (id, org_id, connector_type, name, config, mapping, default_template_id, auto_create,
      mode, interval_seconds, generation, health, next_run_at, cursor, created_at, updated_at)
    VALUES ('conn-1', 'org-a', 'http-json', 'Members', '{"url":"https://example.com/members"}', '{"to":"name"}', ${q(templateId)},
      1, 'hybrid', 3600, 4, 'healthy', ${AT + 9e8}, 'cursor-1', ${AT}, ${AT})`);
  pass('prod-item-1', 'org-a', { connection_id: 'conn-1', external_ref: 'member-1' });
  pass('prod-item-2', 'org-a', { connection_id: 'conn-1', external_ref: 'member-2' });
  add(
    `INSERT INTO webhook_events (connection_id, event_id, received_at) VALUES ('conn-1', 'evt-1', ${AT})`,
  );
  add(`INSERT INTO connection_inbox (connection_id, event_id, ref, record, received_at)
    VALUES ('conn-1', 'evt-1', 'member-3', '{"name":"Three"}', ${AT})`);
  add(`INSERT INTO connection_runs (id, connection_id, trigger, started_at, finished_at, outcome, records_seen, passes_changed)
    VALUES ('run-1', 'conn-1', 'schedule', ${AT}, ${AT + 900}, 'changed', 3, 2)`);

  // Broadcasts: a draft, a scheduled one that is already due, and a sent one with its items.
  const bcast = (id: string, state: string, at: number | null, finishedAt: number | null = null) =>
    add(`INSERT INTO broadcasts (id, org_id, mode, kind, name, state, target, patch, notify, at, created_at, finished_at)
      VALUES (${q(id)}, 'org-a', 'live', 'message', ${q(id)}, ${q(state)}, '{"all":true}', '{"message":"Hi"}', 1, ${q(at)}, ${AT}, ${q(finishedAt)})`);
  bcast('bc-draft', 'draft', null);
  bcast('bc-due', 'scheduled', AT + 1000);
  bcast('bc-sent', 'sent', AT + 2000, AT + 3000);
  add(`INSERT INTO broadcast_items (broadcast_id, pass_id, outcome, silent) VALUES
    ('bc-sent', 'prod-live-1', 'updated', 0), ('bc-sent', 'prod-live-2', 'failed', 1)`);

  // Scanning sessions and a device (the admin console's model); the old config-revision claim.
  add(`INSERT INTO scanning_sessions (id, org_id, mode, name, status, accepts, settings, time_zone, created_at, updated_at, created_by)
    VALUES ('ss-1', 'org-a', 'live', 'Front door', 'active', '{"templates":["up-active"]}', '{"flow":"auto"}', 'UTC', ${AT}, ${AT}, 'u-owner')`);
  add(`INSERT INTO scanning_devices (scanner_id, session_id, org_id, mode, surface, effective_surface, overrides, device_key)
    VALUES ('sc-uploaded-active', 'ss-1', 'org-a', 'live', 'auto', 'phone', '{"sound":false}', 'dk-1')`);
  add(
    `INSERT INTO scanning_config_revisions (kind, target_id, revision) VALUES ('session', 'ss-1', 1), ('device', 'sc-uploaded-active', 1)`,
  );

  add(`INSERT INTO scanners (id, org_id, mode, kind, device_role, name, settings, time_zone, created_at, updated_at)
    VALUES ('sc-test', 'org-a', 'test', 'device', 'scan', 'Test door', '{}', 'UTC', ${AT}, ${AT})`);
  // Scans: a test scan on a test pass, and the old ledger rows (real shapes, never '{}').
  add(`INSERT INTO scans (id, org_id, mode, pass_id, template_id, scanner_id, actor_type, actor_id, actor_key, idempotency_key,
      request_hash, method, state, outcome, action_id, action_kind, direction, pass_version, at) VALUES
    ('scan-test-1', 'org-a', 'test', 'prod-test-1', ${q(templateId)}, 'sc-test', 'scanner', 'sc-test', 's:sc-test', 'idem-test', 'h',
      'manual', 'done', 'ok', 'enter', 'check_in', 'in', 1, ${RECENT})`);
  const event = (id: string, pass: string, kind: string, data: string) =>
    add(`INSERT INTO pass_events (id, org_id, pass_id, mode, kind, actor_type, actor_id, data, at)
      VALUES (${q(id)}, 'org-a', ${q(pass)}, 'live', ${q(kind)}, 'scanner', 'sc-uploaded-active', ${q(data)}, ${RECENT})`);
  event('ev-prod-1', 'prod-live-1', 'scan.checked_in', ledger('scan-x1', 'ok'));
  event(
    'ev-prod-2',
    'prod-live-1',
    'scan.checked_out',
    ledger('scan-x2', 'ok', { direction: 'out' }),
  );
  event(
    'ev-prod-3',
    'prod-live-2',
    'scan.heads_up',
    ledger('scan-x3', 'heads_up', { reason: 'already_in', override: true, approvedBy: 'staff-1' }),
  );
  event(
    'ev-prod-4',
    'prod-live-2',
    'scan.rejected',
    ledger('scan-x4', 'refused', { reason: 'not_found' }),
  );
  event(
    'ev-prod-5',
    'prod-live-2',
    'scan.undone',
    JSON.stringify({ scanId: 'scan-x5', undoes: 'scan-x1' }),
  );
  event('ev-prod-6', 'prod-live-1', 'pass.created', '{"cause":"api"}');

  // Sandbox: a captured email on a test pass (forwarding arrives with 0028).
  add(`INSERT INTO captured_emails (id, org_id, pass_id, recipient, subject, html, text, attached, created_at)
    VALUES ('cap-1', 'org-a', 'prod-test-1', 'tester@example.com', 'Your pass', '<p>Hi</p>', 'Hi', 1, ${AT})`);

  // Pass assets and the member photo, with their R2 objects.
  await bucket.put(LEGACY_ASSET_KEY, new Uint8Array([1, 2, 3]));
  await bucket.put(LEGACY_PHOTO_KEY, new Uint8Array([4, 5, 6, 7]));
  add(`INSERT INTO pass_assets (pass_id, name, r2_key, sha1, size, width, height, crc32, created_at)
    VALUES ('prod-live-1', 'thumbnail.png', ${q(LEGACY_ASSET_KEY)}, ${q('a'.repeat(40))}, 3, 29, 29, 123, ${AT})`);
  add(`INSERT INTO member_photos (pass_id, org_id, r2_key, sha1, size, crc32, include_in_pass, version, updated_at)
    VALUES ('prod-live-1', 'org-a', ${q(LEGACY_PHOTO_KEY)}, ${q('b'.repeat(40))}, 4, 456, 1, 'v1', ${AT})`);

  // Queue rows caught mid-flight. The pending ones are in the base seed.
  add(`INSERT INTO outbox (id, org_id, kind, pass_id, payload, state, enqueued_at, lease, created_at) VALUES
    ('q-push-enq', 'org-a', 'push', 'prod-live-1', '{}', 'enqueued', ${AT}, NULL, ${AT}),
    ('q-push-proc', 'org-a', 'push', 'prod-live-2', '{}', 'processing', ${AT}, 'lease-1', ${AT}),
    ('q-mail-enq', 'org-a', 'email', 'prod-live-1', '{"to":"holder@example.com","attach":false}', 'enqueued', ${AT}, NULL, ${AT}),
    ('q-mail-proc', 'org-a', 'email', 'prod-live-2', '{"to":"other@example.com","attach":false}', 'processing', ${AT}, 'lease-2', ${AT})`);

  // A browser session the old Worker issued, read by the new one with the same cookie.
  add(`INSERT INTO sessions (id_hash, user_id, amr, roles, csrf_secret, created_at, last_seen_at, idle_expires_at, expires_at)
    VALUES (${q(await sha256Hex(LEGACY_COOKIE))}, 'u-admin2', 'magic_link', '["admin","user"]', 'legacy-csrf', ${AT}, ${AT}, ${AT + 9e8}, ${AT + 9e9})`);

  for (const s of stmts) await db.prepare(s).run();
}
