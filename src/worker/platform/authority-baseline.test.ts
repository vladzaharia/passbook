import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { runOne } from '../../../test/helpers/index.ts';
import { seedAuthority } from './authority-test-fixtures.ts';
import { all, first, run } from './db.ts';

/**
 * Cutover window (authority-epochs.md section 6.2): the baseline Worker (8f5bee02) keeps serving
 * against the migrated schema until `versions deploy`. These are baseline write statements, copied
 * from that commit, run against all migrations. `holder edit` is the one expected failure.
 */
const db = env.DB;

describe('baseline writes against the migrated schema', () => {
  it('holder edit (holders/repo.ts setEmailIfUnowned) fails: a holder change needs a transfer', async () => {
    const s = await seedAuthority('base-holder');
    await expect(
      first(
        db,
        'UPDATE passes SET holder_email = ? WHERE id = ? AND owner_user_id IS NULL RETURNING id',
        ['new@example.test', s.pass.id],
      ),
    ).rejects.toThrow(/transfer/i);
  });

  it('org settings upsert, org profile update and branding stamp succeed and move config_revision', async () => {
    const s = await seedAuthority('base-settings');
    const rev = async () =>
      (
        await first<{ r: number }>(db, 'SELECT config_revision AS r FROM orgs WHERE id = ?', [
          s.org.id,
        ])
      )?.r ?? 0;
    const before = await rev();
    const upsert = await run(
      db,
      `INSERT INTO settings (scope, key, value, updated_by, updated_at)
       SELECT 'org:' || o.id, ?, ?, ?, ? FROM orgs o WHERE o.id = ?
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      ['baseline.key', '1', null, 5, s.org.id],
    );
    // The row plus the config_revision bump (D1 counts trigger changes).
    expect(upsert.changes).toBe(2);
    expect(await rev()).toBeGreaterThan(before);
    const stamp = await run(
      db,
      'UPDATE orgs AS o SET updated_at = MAX(o.updated_at + 1, ?) WHERE o.id = ?',
      [9, s.org.id],
    );
    expect(stamp.changes).toBe(1);
    const profile = await run(db, 'UPDATE orgs SET name = ?, updated_at = ? WHERE id = ?', [
      'Renamed',
      11,
      s.org.id,
    ]);
    expect(profile.changes).toBe(2);
  });

  it('pass publish, sync metadata and content updates succeed', async () => {
    const s = await seedAuthority('base-pass');
    const publish = await run(
      db,
      'UPDATE passes SET version = version + 1, revision = revision + 1, display_title = ? WHERE id = ? AND version = ?',
      ['Published', s.pass.id, 1],
    );
    // The row plus one row_version bump per trigger group that fires (content and lifecycle).
    expect(publish.changes).toBe(3);
    const sync = await run(
      db,
      'UPDATE passes SET next_sync_at = ?, last_synced_at = ?, sync_failures = 0 WHERE id = ?',
      [5, 4, s.pass.id],
    );
    expect(sync.changes).toBe(1);
  });

  it('scanner pairing, pair-code issue and heartbeat succeed', async () => {
    const s = await seedAuthority('base-scanner');
    const code = await run(
      db,
      `UPDATE scanners SET pair_code_hash = ?, pair_expires_at = ?, pair_created_by = ?, updated_at = updated_at + 1 WHERE id = ?`,
      ['c'.repeat(64), 9_999_999, s.user.id, s.scannerId],
    );
    expect(code.changes).toBe(2);
    const credential =
      (
        await first<{ credential_epoch: number }>(
          db,
          'SELECT credential_epoch FROM scanners WHERE id = ?',
          [s.scannerId],
        )
      )?.credential_epoch ?? 0;
    const paired = await first(
      db,
      `UPDATE scanners SET token_prefix = ?, token_hash = ?, csrf_secret = ?, paired_at = ?, paired_label = ?,
         expires_at = ?, last_seen_at = ?, revoked_at = NULL, updated_at = updated_at + 1,
         staff_id = NULL, staff_since = NULL, staff_seen_at = NULL, pair_code_hash = NULL
       WHERE id = ? RETURNING id`,
      ['pfx12345', 'd'.repeat(64), 'csrf', 6, 'Door', 9_999_999, 6, s.scannerId],
    );
    expect(paired).not.toBeNull();
    const after =
      (
        await first<{ credential_epoch: number }>(
          db,
          'SELECT credential_epoch FROM scanners WHERE id = ?',
          [s.scannerId],
        )
      )?.credential_epoch ?? 0;
    expect(after).toBeGreaterThan(credential);
    const beat = await run(
      db,
      'UPDATE scanners SET last_seen_at = ?, last_ip_prefix = ? WHERE id = ?',
      [7, '1.2.3', s.scannerId],
    );
    expect(beat.changes).toBe(1);
  });

  it('connection sync writes succeed against the captured generation', async () => {
    const s = await seedAuthority('base-connection');
    const generation =
      (
        await first<{ g: number }>(db, 'SELECT generation AS g FROM connections WHERE id = ?', [
          s.connectionId,
        ])
      )?.g ?? 0;
    const sync = await run(
      db,
      `UPDATE connections SET health = ?, consecutive_failures = 0, cursor = ?, last_run_at = ?, next_run_at = ?, updated_at = ?
       WHERE id = ? AND generation = ?`,
      ['healthy', 'c1', 5, 6, 5, s.connectionId, generation],
    );
    expect(sync.changes).toBe(1);
    const edit = await run(
      db,
      'UPDATE connections SET enabled = 0, generation = generation + 1, updated_at = 7 WHERE id = ? AND generation = ?',
      [s.connectionId, generation],
    );
    expect(edit.changes).toBe(1);
    expect(
      (
        await first<{ g: number }>(db, 'SELECT generation AS g FROM connections WHERE id = ?', [
          s.connectionId,
        ])
      )?.g,
    ).toBe(generation + 1);
  });

  // Baseline statements below are copied from 8f5bee02 (section 6.2 of the design).
  const ensureOrg = (id: string, slug: string) =>
    run(
      db,
      `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (slug) DO NOTHING`,
      [id, slug, 'Baked', 1, 1],
    );

  it('baseline baked-org insert (ON CONFLICT (slug) DO NOTHING) is a known in-window break for an existing slug', async () => {
    const s = await seedAuthority('base-ensure-org');
    const slug =
      (await first<{ slug: string }>(db, 'SELECT slug FROM orgs WHERE id = ?', [s.org.id]))?.slug ??
      '';
    // The current sync looks the org up first and never issues this insert for an existing slug.
    // orgs_no_replace aborts where DO NOTHING used to skip. The baseline skips the whole sync when the
    // stored build hash matches, so this batch runs only when a fresh baked build reaches the old Worker.
    await expect(ensureOrg(s.f.ids.id(), slug)).rejects.toThrow(
      /UNIQUE constraint failed: orgs.slug/,
    );
    const created = await ensureOrg(s.f.ids.id(), `${slug}-new`);
    expect(created.changes).toBe(1);
  });

  it('baked template upsert and a new template version succeed; a re-sent version is refused (0049)', async () => {
    const s = await seedAuthority('base-templates');
    const id = `baked-${s.f.ids.id()}`;
    const upsert = (name: string) =>
      run(
        db,
        `INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles, created_at, updated_at)
         VALUES (?, NULL, ?, ?, NULL, 'baked', '1', 'active', '[]', 1, 1)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description,
           active_version = excluded.active_version, status = 'active', styles = excluded.styles, updated_at = excluded.updated_at`,
        [id, id, name],
      );
    expect((await upsert('one')).changes).toBe(1);
    expect((await upsert('two')).changes).toBe(1);
    const version = (v: string) =>
      run(
        db,
        `INSERT OR IGNORE INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
         VALUES (?, ?, '{}', '{}', '[]', '{}', NULL, 1)`,
        [id, v],
      );
    expect((await version('1')).changes).toBe(1);
    await expect(version('1')).rejects.toThrow();
  });

  it('template upload (uploaded template plus its first version) succeeds', async () => {
    const s = await seedAuthority('base-upload');
    const id = `up-${s.f.ids.id()}`;
    const template = await run(
      db,
      `INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 'Up', NULL, 'uploaded', '1', 'active', '[]', ?, 1, 1)`,
      [id, s.org.id, id, s.user.id],
    );
    expect(template.changes).toBe(1);
    const version = await run(
      db,
      `INSERT OR IGNORE INTO template_versions (template_id, version, manifest, pass_json, assets, report, created_by, created_at)
       VALUES (?, '1', '{}', '{}', '[]', '{}', ?, 1)`,
      [id, s.user.id],
    );
    expect(version.changes).toBe(1);
  });

  it('scan check-in claim (INSERT INTO scans ... ON CONFLICT DO NOTHING RETURNING) succeeds and a replay returns nothing', async () => {
    const s = await seedAuthority('base-scan');
    const claim = (id: string) =>
      all<{ id: string }>(
        db,
        `INSERT INTO scans (id, org_id, mode, scanner_id, event_id, actor_type, actor_id, actor_key, staff_id,
           idempotency_key, request_hash, method, state, client_ts, at)
         VALUES (?, ?, 'live', ?, ?, 'scanner', ?, ?, NULL, 'key-1', ?, 'camera', 'pending', 1, 1)
         ON CONFLICT (actor_key, idempotency_key) DO NOTHING RETURNING id`,
        [
          id,
          s.org.id,
          s.scannerId,
          s.event.id,
          s.scannerId,
          `scanner:${s.scannerId}`,
          'h'.repeat(64),
        ],
      );
    const first1 = s.f.ids.id();
    expect(await claim(first1)).toEqual([{ id: first1 }]);
    expect(await claim(s.f.ids.id())).toEqual([]);
  });

  it('pass create (insertPass, no release) succeeds: 0031 does not require a release at insert', async () => {
    const s = await seedAuthority('base-create');
    const row = await first<Record<string, string | number | null>>(
      db,
      'SELECT * FROM passes WHERE id = ?',
      [s.pass.id],
    );
    const id = s.f.ids.id();
    const create = runOne(
      db,
      `INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token, download_token,
         web_service_url, personalization, field_sources, display_title, display_subtitle, external_id, holder_email,
         connection_id, external_ref, object_key, object_sha256, object_size, content_hash, modified_at, created_by, created_at,
         pending_cause, pending_actor_type, pending_actor_id, pending_pass_json, mode, scan_code, barcode_hash, lookup_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', 'T', NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, 1, NULL, 1,
         'create', NULL, NULL, '{}', 'live', ?, NULL, NULL)`,
      [
        id,
        s.org.id,
        row?.identity_id ?? null,
        `serial-${id}`,
        row?.template_id ?? null,
        row?.template_version ?? null,
        `auth-${id}`,
        `dl-${id}`,
        row?.web_service_url ?? null,
        `key-${id}`,
        'a'.repeat(64),
        'b'.repeat(64),
        `code-${id}`,
      ],
    );
    await create;
    expect(
      (
        await first<{ r: string | null }>(db, 'SELECT release_id AS r FROM passes WHERE id = ?', [
          id,
        ])
      )?.r,
    ).toBeNull();
  });
});
