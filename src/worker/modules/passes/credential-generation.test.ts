import { describe, expect, it } from 'vitest';
import { isolatedKeysetDatabase } from '../../../../test/helpers/credential-keyset.ts';
import {
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
} from '../../../../test/helpers/index.ts';
import {
  credentialAad,
  decryptSecretText,
  encryptSecret,
  loadKekRing,
} from '../../platform/crypto.ts';
import { batch, first, run, stmt } from '../../platform/db.ts';
import { sha256Hex, toBase32 } from '../../platform/ids.ts';
import { setupSamsungCallbacks } from '../wallet-providers/callbacks-test-fixtures.ts';
import { ensureCredentialRefKeyset } from './credential-keyset.ts';
import { credentialTombstoneRef } from './credential-tombstones.ts';
import { setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';

type Snapshot = {
  credential_generation: number;
  lifecycle_generation: number;
  link_generation: number;
  version: number;
  revision: number;
  serial: string;
  auth_token: string;
  download_token: string;
  scan_code: string | null;
  barcode_hash: string | null;
  lookup_hash: string | null;
  holder_email: string | null;
  owner_user_id: string | null;
  object_key: string;
  status: string;
  removed_at: number | null;
  deleted_at: number | null;
  test_data_quarantined: number;
};

async function fixture() {
  const f = fixtures(await makeEnv());
  // The blocked provider placeholders of a generation advance need the keyset to exist.
  await ensureCredentialRefKeyset(f.env.DB, f.env);
  const org = await makeOrg(f);
  const { resolved: template, registry } = makeTemplate();
  const pass = await makePass(f, { orgId: org.id, template, registry });
  return { f, org, pass, template, registry, db: f.env.DB };
}

async function snapshot(db: D1Database, passId: string): Promise<Snapshot> {
  const row = await first<Snapshot>(
    db,
    `SELECT credential_generation, lifecycle_generation, link_generation,
    version, revision, serial, auth_token, download_token, scan_code, barcode_hash, lookup_hash,
    holder_email, owner_user_id, object_key, status, removed_at, deleted_at, test_data_quarantined
    FROM passes WHERE id = ?`,
    [passId],
  );
  if (!row) throw new Error('Missing pass fixture');
  return row;
}

type SnapshotField =
  | 'org_id'
  | 'mode'
  | 'source_generation'
  | 'source_row_version'
  | 'source_lifecycle_generation'
  | 'source_link_generation';

/** The real START ordering: insert a pending reservation, then advance its generation and link. */
function startStatements(
  db: D1Database,
  passId: string,
  transferId: string,
  token: string,
  now: number,
  invalidField?: SnapshotField,
): D1PreparedStatement[] {
  const values: Record<SnapshotField, string> = {
    org_id: invalidField === 'org_id' ? "'not-the-pass-org'" : 'org_id',
    mode: invalidField === 'mode' ? "CASE mode WHEN 'live' THEN 'test' ELSE 'live' END" : 'mode',
    source_generation:
      invalidField === 'source_generation' ? 'credential_generation + 1' : 'credential_generation',
    source_row_version: invalidField === 'source_row_version' ? 'row_version + 1' : 'row_version',
    source_lifecycle_generation:
      invalidField === 'source_lifecycle_generation'
        ? 'lifecycle_generation + 1'
        : 'lifecycle_generation',
    source_link_generation:
      invalidField === 'source_link_generation' ? 'link_generation' : 'link_generation + 1',
  };
  return [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_by_id, requested_at, completed_at)
      SELECT ?, id, ${values.org_id}, ${values.mode}, 'pending', ${values.source_generation},
       version, revision, ${values.source_row_version}, ${values.source_lifecycle_generation},
       ${values.source_link_generation}, 'new-holder@example.test', NULL, 'system', NULL, ?, NULL
      FROM passes WHERE id = ?`,
      [transferId, now, passId],
    ),
    stmt(
      db,
      `UPDATE passes SET credential_generation = credential_generation + 1,
      download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
      [token, passId],
    ),
  ];
}

async function start(db: D1Database, passId: string, now: number) {
  const id = crypto.randomUUID();
  await batch(db, startStatements(db, passId, id, crypto.randomUUID(), now));
  return id;
}

/** One artifact/credential update followed by completion in the same D1 transaction. */
function finishStatements(db: D1Database, passId: string, transferId: string, now: number) {
  return [
    stmt(
      db,
      `UPDATE passes SET serial = ?, auth_token = ?, scan_code = ?, holder_email = ?,
      owner_user_id = NULL, object_key = ?, modified_at = ?, version = version + 1 WHERE id = ?`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        toBase32(crypto.getRandomValues(new Uint8Array(16))),
        'new-holder@example.test',
        `passes/${passId}/${crypto.randomUUID()}.pkpass`,
        now,
        passId,
      ],
    ),
    stmt(
      db,
      `UPDATE pass_credential_transfers SET state = 'completed', completed_at = ?
      WHERE id = ? AND state = 'pending'`,
      [now, transferId],
    ),
  ];
}

describe('0042 credential and lifecycle generations', () => {
  it('maps defaults and preserves an independent generation for link-only rotations', async () => {
    const { db, pass, f } = await fixture();
    const initial = await snapshot(db, pass.id);
    expect(initial).toMatchObject({
      credential_generation: 1,
      lifecycle_generation: 0,
      link_generation: 1,
    });
    expect(await getPass(db, pass.id)).toMatchObject({
      credentialGeneration: 1,
      lifecycleGeneration: 0,
    });
    await run(
      db,
      `UPDATE passes SET download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
      [crypto.randomUUID(), pass.id],
    );
    expect(await snapshot(db, pass.id)).toMatchObject({
      credential_generation: 1,
      lifecycle_generation: 0,
      link_generation: 2,
    });
    await expect(
      run(db, 'UPDATE passes SET credential_generation = 0 WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET credential_generation = 1.5 WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?', [
        pass.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(
        db,
        `UPDATE passes SET credential_generation = credential_generation + 1,
      download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
        [crypto.randomUUID(), pass.id],
      ),
    ).rejects.toThrow();
    await start(db, pass.id, f.clock.now());
    await expect(
      run(db, 'UPDATE passes SET credential_generation = 1 WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    expect(await getPass(db, pass.id)).toMatchObject({
      credentialGeneration: 2,
      lifecycleGeneration: 0,
    });
  });

  it('requires transfers for holder and existing possession credential replacements', async () => {
    const { f, db, pass } = await fixture();
    const user = await makeUser(f);
    const before = await snapshot(db, pass.id);
    for (const [column, value] of [
      ['holder_email', 'other@example.test'],
      ['serial', crypto.randomUUID()],
      ['auth_token', crypto.randomUUID()],
    ] as const) {
      await expect(
        run(db, `UPDATE passes SET ${column} = ? WHERE id = ?`, [value, pass.id]),
      ).rejects.toThrow();
      await expect(
        run(
          db,
          `UPDATE passes SET ${column} = ?, credential_generation = credential_generation + 1
        WHERE id = ?`,
          [value, pass.id],
        ),
      ).rejects.toThrow();
    }
    // Old passes may receive their very first scan code without becoming a new holder.
    await run(db, 'UPDATE passes SET scan_code = ? WHERE id = ?', ['BACKFILLEDCODE', pass.id]);
    expect((await snapshot(db, pass.id)).credential_generation).toBe(before.credential_generation);
    await expect(
      run(db, 'UPDATE passes SET scan_code = ? WHERE id = ?', ['REPLACEMENT', pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET scan_code = NULL WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    await run(
      db,
      'UPDATE passes SET scan_code = scan_code, holder_email = holder_email WHERE id = ?',
      [pass.id],
    );
    expect(await snapshot(db, pass.id)).toMatchObject({
      scan_code: 'BACKFILLEDCODE',
      credential_generation: before.credential_generation,
      holder_email: before.holder_email,
    });
    // A first owner links without a transfer (verified attach of an unchanged credential); an owner
    // never moves or clears, and never moves with a generation, outside one.
    const other = await makeUser(f);
    await expect(
      run(
        db,
        'UPDATE passes SET owner_user_id = ?, credential_generation = credential_generation + 1 WHERE id = ?',
        [user.id, pass.id],
      ),
    ).rejects.toThrow();
    await run(db, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [user.id, pass.id]);
    for (const value of [other.id, null])
      await expect(
        run(db, 'UPDATE passes SET owner_user_id = ? WHERE id = ?', [value, pass.id]),
      ).rejects.toThrow();
    // The owner removing the pass writes the block first; only then may the owner clear.
    await run(
      db,
      'INSERT INTO pass_attach_blocks (pass_id, user_id, created_at) VALUES (?, ?, 1)',
      [pass.id, user.id],
    );
    await run(db, 'UPDATE passes SET owner_user_id = NULL WHERE id = ?', [pass.id]);
  });

  it('requires a version or revision advance for existing barcode and lookup changes without bumping incarnation', async () => {
    const { db, pass } = await fixture();
    await run(db, 'UPDATE passes SET barcode_hash = ?, lookup_hash = ? WHERE id = ?', [
      'a'.repeat(64),
      'b'.repeat(64),
      pass.id,
    ]);
    const before = await snapshot(db, pass.id);
    await expect(
      run(db, 'UPDATE passes SET barcode_hash = ? WHERE id = ?', ['c'.repeat(64), pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET lookup_hash = NULL WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    await run(
      db,
      `UPDATE passes SET barcode_hash = ?, lookup_hash = ?, version = version + 1 WHERE id = ?`,
      ['c'.repeat(64), 'd'.repeat(64), pass.id],
    );
    await run(
      db,
      `UPDATE passes SET barcode_hash = ?, lookup_hash = ?, revision = revision + 1 WHERE id = ?`,
      [before.barcode_hash, before.lookup_hash, pass.id],
    );
    const after = await snapshot(db, pass.id);
    expect(after.credential_generation).toBe(before.credential_generation);
    expect(after.version).toBe(before.version + 1);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.barcode_hash).toBe(before.barcode_hash);
    expect(after.lookup_hash).toBe(before.lookup_hash);
  });

  it('fails closed for signing or tenant identity changes without a durable transfer', async () => {
    const { f, org, db, pass } = await fixture();
    const other = await makeOrg(f);
    const next = crypto.randomUUID();
    await run(
      db,
      `INSERT INTO signing_identities
      (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, created_at)
      VALUES (?, ?, 'Another identity', ?, 'TEAM', 'env', 'TEST', ?)`,
      [next, org.id, `pass.test.${next}`, f.clock.now()],
    );
    const before = await snapshot(db, pass.id);
    for (const [column, value] of [
      ['identity_id', next],
      ['org_id', other.id],
      ['mode', 'test'],
    ] as const) {
      await expect(
        run(db, `UPDATE passes SET ${column} = ? WHERE id = ?`, [value, pass.id]),
      ).rejects.toThrow();
      await expect(
        run(
          db,
          `UPDATE passes SET ${column} = ?, credential_generation = credential_generation + 1
        WHERE id = ?`,
          [value, pass.id],
        ),
      ).rejects.toThrow();
    }
    expect(await snapshot(db, pass.id)).toEqual(before);
  });

  it('invalidates void, deletion and quarantine ABA, but preserves 0030 removal publication claims', async () => {
    const { db, pass, f } = await fixture();
    const generation = async () => (await snapshot(db, pass.id)).lifecycle_generation;
    const initial = await generation();
    await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    await run(db, "UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
    expect(await generation()).toBe(initial + 2);
    await run(db, 'UPDATE passes SET deleted_at = 10 WHERE id = ?', [pass.id]);
    await run(db, 'UPDATE passes SET deleted_at = NULL WHERE id = ?', [pass.id]);
    await run(db, 'UPDATE passes SET test_data_quarantined = 1 WHERE id = ?', [pass.id]);
    await run(db, 'UPDATE passes SET test_data_quarantined = 0 WHERE id = ?', [pass.id]);
    expect(await generation()).toBe(initial + 6);
    await run(
      db,
      `UPDATE passes SET removed_at = ?, lifecycle_generation = lifecycle_generation + 1 WHERE id = ?`,
      [f.clock.now(), pass.id],
    );
    const claimed = await generation();
    expect(claimed).toBe(initial + 7);
    await run(
      db,
      `UPDATE passes SET status = 'voided', version = version + 1, object_key = ?,
      removal_published_generation = lifecycle_generation WHERE id = ?`,
      [`passes/${pass.id}/removed.pkpass`, pass.id],
    );
    expect(
      await first(
        db,
        'SELECT lifecycle_generation, removal_published_generation FROM passes WHERE id = ?',
        [pass.id],
      ),
    ).toEqual({ lifecycle_generation: claimed, removal_published_generation: claimed });
    await run(
      db,
      `UPDATE passes SET removed_at = NULL, status = 'active',
      lifecycle_generation = lifecycle_generation + 1 WHERE id = ?`,
      [pass.id],
    );
    expect(await generation()).toBe(claimed + 1);
    expect((await getPass(db, pass.id))?.lifecycleGeneration).toBe(claimed + 1);
  });

  it('clears the refresh coalescing marker on credential and lifecycle authority changes', async () => {
    const { db, pass, f } = await fixture();
    const refresh = () =>
      first<{ refresh_requested_at: number | null }>(
        db,
        'SELECT refresh_requested_at FROM passes WHERE id = ?',
        [pass.id],
      );
    await run(db, 'UPDATE passes SET refresh_requested_at = 10 WHERE id = ?', [pass.id]);
    await run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    expect(await refresh()).toEqual({ refresh_requested_at: null });
    await run(db, 'UPDATE passes SET refresh_requested_at = 20 WHERE id = ?', [pass.id]);
    await run(db, "UPDATE passes SET status = 'active' WHERE id = ?", [pass.id]);
    expect(await refresh()).toEqual({ refresh_requested_at: null });
    await run(db, 'UPDATE passes SET refresh_requested_at = 30 WHERE id = ?', [pass.id]);
    await start(db, pass.id, f.clock.now());
    expect(await refresh()).toEqual({ refresh_requested_at: null });
  });

  it('rolls back automatic lifecycle and credential changes when a D1 batch fails', async () => {
    const { db, pass } = await fixture();
    const before = await snapshot(db, pass.id);
    await expect(
      batch(db, [
        stmt(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]),
        stmt(db, 'UPDATE passes SET credential_generation = 0 WHERE id = ?', [pass.id]),
      ]),
    ).rejects.toThrow();
    expect(await snapshot(db, pass.id)).toEqual(before);
  });

  it('does not allow SQLite REPLACE to erase a pass or recreate an old generation', async () => {
    const { db, pass, f, org, template, registry } = await fixture();
    const other = await makePass(f, { orgId: org.id, template, registry });
    const before = await snapshot(db, pass.id);
    const otherBefore = await snapshot(db, other.id);
    await expect(
      run(db, 'INSERT OR REPLACE INTO passes SELECT * FROM passes WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE OR REPLACE passes SET download_token = ? WHERE id = ?', [
        before.download_token,
        other.id,
      ]),
    ).rejects.toThrow();
    expect(await snapshot(db, pass.id)).toEqual(before);
    expect(await snapshot(db, other.id)).toEqual(otherBefore);
  });
});

describe('0042 pending transfer snapshots', () => {
  it.each([
    'org_id',
    'mode',
    'source_generation',
    'source_row_version',
    'source_lifecycle_generation',
    'source_link_generation',
  ] as const)(
    'rejects a mismatched %s and rolls back the reserved generation/link',
    async (field) => {
      const { db, pass, f } = await fixture();
      const before = await snapshot(db, pass.id);
      await expect(
        batch(
          db,
          startStatements(
            db,
            pass.id,
            crypto.randomUUID(),
            crypto.randomUUID(),
            f.clock.now(),
            field,
          ),
        ),
      ).rejects.toThrow();
      expect(await snapshot(db, pass.id)).toEqual(before);
      expect(
        await first(db, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [pass.id]),
      ).toBeNull();
    },
  );

  it('rolls back the reservation and leaves providers untouched if the link token was not rotated', async () => {
    const { db, pass, f } = await fixture();
    const before = await snapshot(db, pass.id);
    await expect(
      batch(
        db,
        startStatements(db, pass.id, crypto.randomUUID(), before.download_token, f.clock.now()),
      ),
    ).rejects.toThrow();
    expect(await snapshot(db, pass.id)).toEqual(before);
    expect(
      await first(db, 'SELECT id FROM pass_credential_transfers WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instances WHERE pass_id = ?', [pass.id]),
    ).toBeNull();
  });

  it.each([
    ['voided', "UPDATE passes SET status = 'voided' WHERE id = ?"],
    ['removed', 'UPDATE passes SET removed_at = 123 WHERE id = ?'],
    ['deleted', 'UPDATE passes SET deleted_at = 123 WHERE id = ?'],
  ])(
    'preserves a %s source lifecycle while rotating its holder credential',
    async (_label, mutation) => {
      const { db, pass, f } = await fixture();
      await run(db, mutation, [pass.id]);
      const before = await snapshot(db, pass.id);
      const transferId = await start(db, pass.id, f.clock.now());
      if (_label === 'removed') {
        await expect(
          run(db, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]),
        ).rejects.toThrow();
      }
      await batch(db, finishStatements(db, pass.id, transferId, f.clock.now() + 1));
      const after = await snapshot(db, pass.id);
      expect(after).toMatchObject({
        status: before.status,
        removed_at: before.removed_at,
        deleted_at: before.deleted_at,
        lifecycle_generation: before.lifecycle_generation,
        credential_generation: before.credential_generation + 1,
        holder_email: 'new-holder@example.test',
      });
    },
  );

  it('takes one immutable post-start snapshot and only completes after a full credential/artifact rotation', async () => {
    const { db, pass, f, org } = await fixture();
    const before = await snapshot(db, pass.id);
    const transferId = await start(db, pass.id, f.clock.now());
    const pending = await snapshot(db, pass.id);
    expect(pending.credential_generation).toBe(before.credential_generation + 1);
    expect(pending.link_generation).toBe(before.link_generation + 1);
    expect(pending.download_token).not.toBe(before.download_token);
    expect(
      await first(
        db,
        `SELECT pass_id, org_id, mode, state, source_generation, target_generation,
      source_version, source_revision, source_lifecycle_generation, source_link_generation,
      target_holder_email, target_owner_user_id, completed_at FROM pass_credential_transfers WHERE id = ?`,
        [transferId],
      ),
    ).toEqual({
      pass_id: pass.id,
      org_id: org.id,
      mode: 'live',
      state: 'pending',
      source_generation: before.credential_generation,
      target_generation: pending.credential_generation,
      source_version: pending.version,
      source_revision: pending.revision,
      source_lifecycle_generation: pending.lifecycle_generation,
      source_link_generation: pending.link_generation,
      target_holder_email: 'new-holder@example.test',
      target_owner_user_id: null,
      completed_at: null,
    });

    await expect(
      run(
        db,
        "UPDATE pass_credential_transfers SET state = 'completed', completed_at = ? WHERE id = ?",
        [f.clock.now() + 1, transferId],
      ),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE pass_credential_transfers SET target_holder_email = ? WHERE id = ?', [
        'attacker@example.test',
        transferId,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, 'DELETE FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).rejects.toThrow();
    await expect(run(db, 'DELETE FROM passes WHERE id = ?', [pass.id])).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?', [
        pass.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET holder_email = ? WHERE id = ?', [
        'new-holder@example.test',
        pass.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET serial = ?, version = version + 1 WHERE id = ?', [
        crypto.randomUUID(),
        pass.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET revision = revision + 1 WHERE id = ?', [pass.id]),
    ).rejects.toThrow();
    for (const sql of [
      "UPDATE passes SET external_ref = 'other-source' WHERE id = ?",
      "UPDATE passes SET web_service_url = 'https://other.example/wallet' WHERE id = ?",
      'UPDATE passes SET personalization = \'{"memberName":"other"}\' WHERE id = ?',
      'UPDATE passes SET field_sources = \'{"memberName":"connection"}\' WHERE id = ?',
      "UPDATE passes SET display_title = 'changed while pending' WHERE id = ?",
    ])
      await expect(run(db, sql, [pass.id])).rejects.toThrow();
    await expect(
      run(
        db,
        `INSERT OR REPLACE INTO pass_credential_transfers
      (id,pass_id,org_id,mode,state,source_generation,source_version,source_revision,
       source_lifecycle_generation,source_link_generation,target_holder_email,target_owner_user_id,
       requested_by_type,requested_by_id,requested_at,completed_at)
      SELECT id,pass_id,org_id,mode,state,source_generation,source_version,source_revision,
       source_lifecycle_generation,source_link_generation,target_holder_email,target_owner_user_id,
       requested_by_type,requested_by_id,requested_at,completed_at FROM pass_credential_transfers WHERE id = ?`,
        [transferId],
      ),
    ).rejects.toThrow();
    expect(await snapshot(db, pass.id)).toEqual(pending);

    await batch(db, finishStatements(db, pass.id, transferId, f.clock.now() + 1));
    const completed = await snapshot(db, pass.id);
    expect(completed).toMatchObject({
      credential_generation: pending.credential_generation,
      lifecycle_generation: pending.lifecycle_generation,
      link_generation: pending.link_generation,
      holder_email: 'new-holder@example.test',
      owner_user_id: null,
      version: pending.version + 1,
    });
    expect(completed.revision).toBeGreaterThan(pending.revision);
    expect(completed.serial).not.toBe(pending.serial);
    expect(completed.auth_token).not.toBe(pending.auth_token);
    expect(completed.scan_code).not.toBe(pending.scan_code);
    expect(
      await first(db, 'SELECT state, completed_at FROM pass_credential_transfers WHERE id = ?', [
        transferId,
      ]),
    ).toEqual({ state: 'completed', completed_at: f.clock.now() + 1 });
    await expect(
      run(
        db,
        "UPDATE pass_credential_transfers SET state = 'pending', completed_at = NULL WHERE id = ?",
        [transferId],
      ),
    ).rejects.toThrow();
    await expect(
      run(db, 'DELETE FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).rejects.toThrow();
    await expect(
      run(db, 'UPDATE passes SET credential_generation = ? WHERE id = ?', [
        before.credential_generation,
        pass.id,
      ]),
    ).rejects.toThrow();
  });

  it('does not expose a target credential when an older issued provider has not retired', async () => {
    const t = await setupSamsungCallbacks({ db: await isolatedKeysetDatabase() });
    const { db, passId, now } = { db: t.kit.env.DB, passId: t.pass.id, now: t.kit.clock.now() };
    const transferId = await start(db, passId, now);
    const pending = await snapshot(db, passId);
    await expect(batch(db, finishStatements(db, passId, transferId, now + 1))).rejects.toThrow();
    expect(await snapshot(db, passId)).toEqual(pending);
    expect(
      await first(db, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).toEqual({ state: 'pending' });
  }, 120_000);

  it.each(['current', 'stale'] as const)(
    'retains connection proof and encrypted target content until a %s-connection completion',
    async (connectionState) => {
      const kit = await setupKit();
      await ensureCredentialRefKeyset(kit.env.DB, kit.env);
      const pass = await kit.pass();
      const release = kit.liveRelease;
      if (!release) throw new Error('Missing approved release');
      const db = kit.env.DB;
      const now = kit.clock.now();
      const connectionId = crypto.randomUUID();
      await run(
        db,
        `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at)
        VALUES (?, ?, 'demo', 'Credential test', ?, ?)`,
        [connectionId, kit.org.id, now, now],
      );
      // NULL external_ref is a valid verified-attach connection snapshot.
      await run(db, 'UPDATE passes SET connection_id = ?, external_ref = NULL WHERE id = ?', [
        connectionId,
        pass.id,
      ]);
      const original = await snapshot(db, pass.id);
      const transferId = crypto.randomUUID();
      const connectionStart = (generation: number) => [
        stmt(
          db,
          `INSERT INTO pass_credential_transfers
          (id,pass_id,org_id,mode,state,source_generation,source_version,source_revision,source_row_version,
           source_lifecycle_generation,source_link_generation,source_connection_id,source_connection_ref,
           source_connection_generation,source_connection_mode,source_admitted_release_id,
           source_admitted_release_generation,source_admitted_release_version,target_holder_email,
           target_owner_user_id,requested_by_type,requested_by_id,requested_at,completed_at)
          SELECT ?,id,org_id,mode,'pending',credential_generation,version,revision,row_version,lifecycle_generation,
           link_generation+1,?,NULL,?,'poll',?,?,?,'new-holder@example.test',NULL,'system',NULL,?,NULL
          FROM passes WHERE id = ?`,
          [
            transferId,
            connectionId,
            generation,
            release.id,
            release.generation,
            release.version,
            now,
            pass.id,
          ],
        ),
        stmt(
          db,
          `UPDATE passes SET credential_generation = credential_generation + 1,
          download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
          [crypto.randomUUID(), pass.id],
        ),
      ];
      await expect(batch(db, connectionStart(2))).rejects.toThrow();
      expect(await snapshot(db, pass.id)).toEqual(original);
      await batch(db, connectionStart(1));
      const pending = await snapshot(db, pass.id);
      await expect(batch(db, finishStatements(db, pass.id, transferId, now + 1))).rejects.toThrow();
      expect(await snapshot(db, pass.id)).toEqual(pending);

      const ring = await loadKekRing(kit.env);
      const aad = credentialAad(transferId, kit.org.id, 'transfer-test');
      const content = JSON.stringify({
        personalization: { memberName: 'Target' },
        fieldSources: {},
      });
      const sealed = await encryptSecret(ring, content, aad);
      const payloadInsert = `INSERT INTO pass_credential_transfer_payloads
        (transfer_id,kek_version,iv,wrapped_dek,ciphertext) VALUES (?,?,?,?,?)`;
      await run(db, payloadInsert, [
        transferId,
        sealed.kekVersion,
        sealed.iv,
        sealed.wrappedDek,
        sealed.ciphertext,
      ]);
      const stored = await first<{
        kek_version: number;
        iv: ArrayBuffer;
        wrapped_dek: ArrayBuffer;
        ciphertext: ArrayBuffer;
      }>(
        db,
        'SELECT kek_version, iv, wrapped_dek, ciphertext FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
        [transferId],
      );
      if (!stored) throw new Error('Missing encrypted payload');
      expect(
        await decryptSecretText(
          ring,
          {
            kekVersion: stored.kek_version,
            iv: new Uint8Array(stored.iv),
            wrappedDek: new Uint8Array(stored.wrapped_dek),
            ciphertext: new Uint8Array(stored.ciphertext),
          },
          aad,
        ),
      ).toBe(content);
      await expect(
        run(db, payloadInsert.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), [
          transferId,
          sealed.kekVersion,
          sealed.iv,
          sealed.wrappedDek,
          sealed.ciphertext,
        ]),
      ).rejects.toThrow();
      await expect(
        run(db, 'DELETE FROM pass_credential_transfer_payloads WHERE transfer_id = ?', [
          transferId,
        ]),
      ).rejects.toThrow();
      await expect(
        run(
          db,
          'UPDATE pass_credential_transfers SET source_connection_generation = 2 WHERE id = ?',
          [transferId],
        ),
      ).rejects.toThrow();

      if (connectionState === 'stale') {
        // A connection edit while the transfer is pending must not wedge its completion (F11).
        await run(db, 'UPDATE connections SET generation = generation + 1 WHERE id = ?', [
          connectionId,
        ]);
      }
      await batch(db, [
        ...finishStatements(db, pass.id, transferId, now + 1),
        stmt(db, 'DELETE FROM pass_credential_transfer_payloads WHERE transfer_id = ?', [
          transferId,
        ]),
      ]);
      expect(
        await first(db, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [transferId]),
      ).toEqual({ state: 'completed' });
      expect(
        await first(
          db,
          'SELECT transfer_id FROM pass_credential_transfer_payloads WHERE transfer_id = ?',
          [transferId],
        ),
      ).toBeNull();
    },
    120_000,
  );

  it('retains scoped keyed tombstones and rejects changes, deletion and replacement', async () => {
    const { db, pass, org, f } = await fixture();
    const oldCode = 'A'.repeat(26);
    await run(db, 'UPDATE passes SET scan_code = ? WHERE id = ?', [oldCode, pass.id]);
    const before = await snapshot(db, pass.id);
    const transferId = await start(db, pass.id, f.clock.now());
    const hash = await credentialTombstoneRef(f.env, org.id, 'live', await sha256Hex(oldCode));
    const insert = `INSERT INTO pass_credential_tombstones
      (pass_id, org_id, mode, credential_generation, credential_kind, credential_hash, retired_at)
      VALUES (?, ?, 'live', ?, 'scan_code', ?, ?)`;
    await run(db, insert, [pass.id, org.id, before.credential_generation, hash, f.clock.now()]);
    expect(
      await first(
        db,
        `SELECT credential_kind FROM pass_credential_tombstones
      WHERE org_id = ? AND mode = 'live' AND credential_hash = ?`,
        [org.id, hash],
      ),
    ).toEqual({ credential_kind: 'scan_code' });
    await expect(
      run(db, 'UPDATE pass_credential_tombstones SET mode = ? WHERE pass_id = ?', [
        'test',
        pass.id,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, 'DELETE FROM pass_credential_tombstones WHERE pass_id = ?', [pass.id]),
    ).rejects.toThrow();
    await expect(
      run(db, insert.replace('INSERT INTO', 'INSERT OR REPLACE INTO'), [
        pass.id,
        org.id,
        before.credential_generation,
        hash,
        f.clock.now() + 1,
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, insert, [
        pass.id,
        org.id,
        before.credential_generation + 1,
        'b'.repeat(64),
        f.clock.now(),
      ]),
    ).rejects.toThrow();
    await expect(
      run(db, insert, [pass.id, org.id, before.credential_generation, 'not-a-hash', f.clock.now()]),
    ).rejects.toThrow();
    await batch(db, finishStatements(db, pass.id, transferId, f.clock.now() + 1));
    expect(
      await first(
        db,
        `SELECT credential_hash FROM pass_credential_tombstones
      WHERE org_id = ? AND mode = 'live' AND credential_hash = ?`,
        [org.id, hash],
      ),
    ).toEqual({ credential_hash: hash });
    // There is intentionally no foreign key to passes: retention must not revive old credentials.
    expect(
      await first(
        db,
        "SELECT 1 AS present FROM pragma_foreign_key_list('pass_credential_tombstones') WHERE \"table\" = 'passes'",
      ),
    ).toBeNull();
  });
});

describe('0042 holder reissue requirement', () => {
  it('accepts only an exact, verified, unblocked holder snapshot and clears stale requirements atomically', async () => {
    const f = fixtures(await makeEnv());
    const db = f.env.DB;
    const org = await makeOrg(f);
    const user = await makeUser(f);
    const stranger = await makeUser(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, {
      orgId: org.id,
      template,
      registry,
      holderEmail: user.primaryEmail,
    });
    const insert = `INSERT OR IGNORE INTO pass_holder_reissue_required
      (pass_id,org_id,mode,user_id,credential_generation,version,revision,lifecycle_generation,
       link_generation,release_id,detected_at)
      SELECT id,org_id,mode,?,credential_generation,version,revision,lifecycle_generation,
       link_generation,release_id,? FROM passes WHERE id = ?`;
    const params = [user.id, f.clock.now(), pass.id] as const;
    await expect(run(db, insert, [stranger.id, f.clock.now(), pass.id])).rejects.toThrow();
    await run(db, "UPDATE users SET status = 'disabled' WHERE id = ?", [user.id]);
    await expect(run(db, insert, params)).rejects.toThrow();
    await run(db, "UPDATE users SET status = 'active' WHERE id = ?", [user.id]);
    await run(db, 'INSERT INTO pass_attach_blocks(pass_id,user_id,created_at) VALUES (?,?,?)', [
      pass.id,
      user.id,
      f.clock.now(),
    ]);
    await expect(run(db, insert, params)).rejects.toThrow();
    await run(db, 'DELETE FROM pass_attach_blocks WHERE pass_id = ? AND user_id = ?', [
      pass.id,
      user.id,
    ]);
    await expect(
      run(
        db,
        insert.replace(
          'SELECT id,org_id,mode,?,credential_generation,version,',
          'SELECT id,org_id,mode,?,credential_generation,version+1,',
        ),
        params,
      ),
    ).rejects.toThrow();
    await run(db, insert, params);
    expect(await run(db, insert, params)).toEqual({ changes: 0 });
    expect(
      await first(
        db,
        'SELECT user_id, org_id, mode FROM pass_holder_reissue_required WHERE pass_id = ?',
        [pass.id],
      ),
    ).toEqual({ user_id: user.id, org_id: org.id, mode: 'live' });
    expect(
      await first(
        db,
        `SELECT 1 AS present FROM pragma_table_info('pass_holder_reissue_required')
      WHERE name IN ('holder_email', 'download_token')`,
      ),
    ).toBeNull();

    // An aborted publish must not clear the requirement; a real version change makes it stale.
    await expect(
      batch(db, [
        stmt(db, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]),
        stmt(db, 'UPDATE passes SET credential_generation = 0 WHERE id = ?', [pass.id]),
      ]),
    ).rejects.toThrow();
    expect(
      await first(db, 'SELECT pass_id FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual({ pass_id: pass.id });
    await run(db, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    expect(
      await first(db, 'SELECT pass_id FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    await run(db, insert, params);
    await start(db, pass.id, f.clock.now());
    expect(
      await first(db, 'SELECT pass_id FROM pass_holder_reissue_required WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toBeNull();
    await expect(run(db, insert, params)).rejects.toThrow();
  });
});
