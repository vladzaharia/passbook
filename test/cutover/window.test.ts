// Between `--migrate-only` and `--promote` the old Worker (main, 8f5bee02) serves the migrated schema.
// Its holder and owner writes, verbatim, and the promote's sync trigger with a key it created.
// docs/operations.md, "Temporary WAF rule" and "Order" step 3, rely on these outcomes.
import { env as bindings } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app.ts';
import { createApiKeyStore } from '../../src/worker/modules/api-keys/service.ts';
import { resetBakedSync } from '../../src/worker/modules/templates/sync.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { sha256Hex } from '../../src/worker/platform/ids.ts';
import { fakeAuth, makeEnv } from '../helpers/index.ts';
import { AT, legacyDatabase, migrateForward, OWNER, seedLegacy } from './legacy-seed.ts';
import { runBootstrap } from './run-bootstrap.ts';

/** A templates:read key the old Worker issued in the pre-checks (`wlt_<prefix>_<secret>`). */
const KEY = `wlt_cutover1_${'k'.repeat(43)}`;
const TRANSFER = /credential transfer required/;

let db: D1Database;
beforeAll(async () => {
  db = await legacyDatabase(26);
  await seedLegacy(db, bindings.BUCKET);
  await db
    .prepare(`INSERT INTO api_keys (id, org_id, name, prefix, key_hash, scopes, created_by, created_at, mode)
      VALUES ('key-cutover', 'org-a', 'Cutover', 'cutover1', ?, '["templates:read"]', 'u-owner', ?, 'live')`)
    .bind(await sha256Hex(KEY), AT)
    .run();
  // A Test pass waiting for its holder; 0025 quarantines it.
  await db
    .prepare(`INSERT INTO passes (id, org_id, identity_id, serial, template_id, template_version, auth_token,
      download_token, web_service_url, personalization, display_title, holder_email, status, version, object_key,
      modified_at, created_at, mode) VALUES ('pass-test-waiting', 'org-a', 'platform', 'serial-test-waiting',
      'up-active', 'v2', 'auth-test-waiting', 'dl-test-waiting', 'https://wallet.plrs.im/v1', '{}', 'Test',
      'tester@example.com', 'active', 1, 'passes/pass-test-waiting/1.pkpass', ?1, ?1, 'test')`)
    .bind(AT)
    .run();
  await migrateForward(db);
}, 120_000);

const write = (sql: string, ...params: (string | number)[]) =>
  db
    .prepare(sql)
    .bind(...params)
    .all();

describe('cutover window: old Worker holder writes', () => {
  it('holder edit fails (holders/repo.ts setEmailIfUnowned, reassign)', async () => {
    await expect(
      write(
        'UPDATE passes SET holder_email = ? WHERE id = ? AND owner_user_id IS NULL RETURNING id',
        'new@example.com',
        'pass-baked-unassigned-2',
      ),
    ).rejects.toThrow(TRANSFER);
    await expect(
      write(
        'UPDATE passes SET holder_email = ?, owner_user_id = NULL WHERE id = ?',
        'x@example.com',
        'pass-baked-assigned-1',
      ),
    ).rejects.toThrow(TRANSFER);
  });

  it('deleting an owned pass fails; an unowned one is deleted (passes/repo-ops.ts softDeletePass)', async () => {
    const softDelete = (id: string) =>
      write(
        `UPDATE passes SET deleted_at = ?, owner_user_id = NULL, connection_id = NULL, external_ref = NULL,
           next_sync_at = NULL WHERE id = ?`,
        Date.now(),
        id,
      );
    await expect(softDelete('pass-uploaded-active-1')).rejects.toThrow(TRANSFER);
    await expect(softDelete('pass-uploaded-active-2')).resolves.toBeTruthy();
  });

  it('attach on create, self-remove and sign-in attach succeed for the verified holder (0055: the owner moves, the credential does not)', async () => {
    const pass = 'pass-baked-unassigned-4';
    // holders/repo.ts attachOwner (hook A, pass create for a holder with an account).
    const attachOwner = (user: string) =>
      write(
        `UPDATE passes SET owner_user_id = ?1 WHERE id = ?2 AND owner_user_id IS NULL
         AND holder_email IS ?3 AND ?1 IS NOT NULL RETURNING id`,
        user,
        pass,
        'other@example.com',
      );
    // Only a user who verified the holder email may become the owner.
    await expect(attachOwner('u-admin2')).rejects.toThrow(TRANSFER);
    await write(
      `INSERT INTO user_emails (email, user_id, verified_via, verified_at)
       VALUES ('other@example.com', 'u-admin2', 'magic_link', ?)`,
      AT,
    );
    expect((await attachOwner('u-admin2')).results).toEqual([{ id: pass }]);
    // addBlockAndClearOwner (DELETE /api/v1/me/passes/{id}).
    await write(
      'INSERT OR IGNORE INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, ?)',
      pass,
      'u-admin2',
      Date.now(),
    );
    const removed = await write(
      'UPDATE passes SET owner_user_id = NULL WHERE id = ? AND owner_user_id = ? RETURNING id',
      pass,
      'u-admin2',
    );
    expect(removed.results).toEqual([{ id: pass }]);
    // The address moves to the owner's account; attachWaiting (hook B, sign-in of a holder with a
    // waiting pass) links it there.
    await write("UPDATE user_emails SET user_id = 'u-owner' WHERE email = 'other@example.com'");
    const signedIn = await write(
      `UPDATE passes SET owner_user_id = ?1
       WHERE holder_email = ?2 AND owner_user_id IS NULL AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = passes.id AND b.user_id = ?1)
       RETURNING id, org_id`,
      'u-owner',
      'other@example.com',
    );
    expect(signedIn.results).toEqual([{ id: pass, org_id: 'org-b' }]);
  });

  it('sign-in attach fails for a holder with a waiting quarantined Test pass (0055), and links nothing', async () => {
    await write(
      `INSERT INTO user_emails (email, user_id, verified_via, verified_at)
       VALUES ('tester@example.com', 'u-holder', 'magic_link', ?)`,
      AT,
    );
    await expect(
      write(
        `UPDATE passes SET owner_user_id = ?1
         WHERE holder_email = ?2 AND owner_user_id IS NULL AND deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks b WHERE b.pass_id = passes.id AND b.user_id = ?1)
         RETURNING id`,
        'u-holder',
        'tester@example.com',
      ),
    ).rejects.toThrow(TRANSFER);
    const row = await db
      .prepare(
        "SELECT owner_user_id, test_data_quarantined FROM passes WHERE id = 'pass-test-waiting'",
      )
      .first();
    expect(row).toEqual({ owner_user_id: null, test_data_quarantined: 1 });
  });
});

describe('cutover window: promote', () => {
  it('a templates:read key from before the migrations runs the baked sync through GET /api/v1/templates', async () => {
    await runBootstrap(db, OWNER, Date.now());
    const env = {
      ...(await makeEnv({ DB: db })),
      CF_VERSION: { id: 'new-worker', tag: '', timestamp: new Date().toISOString() },
    } as AppEnv;
    const app = createApp({ stores: { ...fakeAuth().stores, apiKeys: createApiKeyStore(env) } });
    resetBakedSync();
    const res = await app.request(
      'https://passbook.mobile/api/v1/templates',
      { headers: { authorization: `Bearer ${KEY}` } },
      env,
    );
    expect(res.status).toBe(200);
    const adoption = await db
      .prepare(
        "SELECT value FROM settings WHERE scope = 'system' AND key = 'templates.baked_adoption'",
      )
      .first<{ value: string }>();
    expect(adoption?.value).toBeTruthy();
  });
});
