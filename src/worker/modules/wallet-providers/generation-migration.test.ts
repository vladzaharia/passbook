import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { fixtures, makeOrg, makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { credentialAad, encryptSecret, loadKekRing } from '../../platform/crypto.ts';
import { all, batch, first, run, stmt } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { withKitDatabase } from '../passes/pass-test-fixtures.ts';
import {
  seedHistoricalProviderInstance,
  seedHistoricalSamsungRef,
} from './runtime-historical-fixtures.ts';
import {
  runtimeGoogleLegacyFixture as setupGoogleLegacyFixture,
  runtimeSamsungLegacyFixture as setupSamsungLegacyFixture,
} from './runtime-integration-fixtures.ts';
import { createSamsungRefId } from './samsung.ts';

const testEnv = installKeysetTestEnv();

async function runtimeGoogleLegacyFixture() {
  return setupGoogleLegacyFixture({ db: (await testEnv()).DB });
}

async function runtimeSamsungLegacyFixture(kind: 'refresh' | 'retirement') {
  return withKitDatabase((await testEnv()).DB, () => setupSamsungLegacyFixture(kind));
}

async function fixture() {
  const f = fixtures(await testEnv());
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(f.env.DB, f.env);
  const org = await makeOrg(f);
  const pass = await makePass(f, { orgId: org.id, template: makeTemplate().resolved });
  return { f, pass, db: f.env.DB, credentialKeysetCommitment };
}

type InstanceRow = {
  id: string;
  provider: string;
  credential_generation: number;
  lifecycle: string;
  retirement_reason: string | null;
};

function instances(db: D1Database, passId: string): Promise<InstanceRow[]> {
  return all(
    db,
    `SELECT id, provider, credential_generation, lifecycle, retirement_reason
    FROM wallet_provider_instances WHERE pass_id = ? ORDER BY credential_generation, provider`,
    [passId],
  );
}

function startStatements(db: D1Database, passId: string, id: string, now: number) {
  return [
    stmt(
      db,
      `INSERT INTO pass_credential_transfers
      (id, pass_id, org_id, mode, state, source_generation, source_version, source_revision, source_row_version,
       source_lifecycle_generation, source_link_generation, target_holder_email, target_owner_user_id,
       requested_by_type, requested_at)
      SELECT ?, id, org_id, mode, 'pending', credential_generation, version, revision, row_version,
        lifecycle_generation, link_generation + 1, 'new-holder@example.test', NULL, 'system', ?
      FROM passes WHERE id = ?`,
      [id, now, passId],
    ),
    stmt(
      db,
      `UPDATE passes SET credential_generation = credential_generation + 1,
      download_token = ?, link_generation = link_generation + 1 WHERE id = ?`,
      [crypto.randomUUID(), passId],
    ),
  ];
}

async function start(db: D1Database, passId: string, now: number): Promise<string> {
  const id = crypto.randomUUID();
  await batch(db, startStatements(db, passId, id, now));
  return id;
}

function finish(db: D1Database, passId: string, transferId: string, now: number) {
  return batch(db, [
    stmt(
      db,
      `UPDATE passes SET serial = ?, auth_token = ?, scan_code = ?, holder_email = ?,
      owner_user_id = NULL, object_key = ?, modified_at = ?, version = version + 1 WHERE id = ?`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
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
  ]);
}

async function expectCanonicalCommitmentChecks(db: D1Database, table: string, commitment: string) {
  const row = await first<{ id: number }>(
    db,
    `SELECT rowid AS id FROM ${table} WHERE credential_keyset_commitment = ? LIMIT 1`,
    [commitment],
  );
  if (!row) throw new Error(`Missing canonical fixture row in ${table}`);
  const triggers = await all<{ name: string; sql: string }>(
    db,
    "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?",
    [table],
  );
  for (const trigger of triggers) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trigger.name))
      throw new Error('Unexpected fixture trigger name');
  }
  await batch(
    db,
    triggers.map((trigger) => stmt(db, `DROP TRIGGER ${trigger.name}`)),
  );
  try {
    for (const invalid of [
      `CAST('${'a'.repeat(64)}' AS BLOB)`,
      `'${'a'.repeat(64)}' || char(0) || 'x'`,
      `'${'A'.repeat(64)}'`,
      `'${'a'.repeat(63)}'`,
    ]) {
      await expect(
        run(db, `UPDATE ${table} SET credential_keyset_commitment = ${invalid} WHERE rowid = ?`, [
          row.id,
        ]),
      ).rejects.toThrow(/CHECK constraint failed/i);
      expect(
        await first(db, `SELECT credential_keyset_commitment FROM ${table} WHERE rowid = ?`, [
          row.id,
        ]),
      ).toEqual({ credential_keyset_commitment: commitment });
    }
    expect(
      (
        await run(db, `UPDATE ${table} SET credential_keyset_commitment = ? WHERE rowid = ?`, [
          commitment,
          row.id,
        ])
      ).changes,
    ).toBe(1);
  } finally {
    await batch(
      db,
      triggers.map((trigger) => stmt(db, trigger.sql)),
    );
  }
}

describe('0043 provider generation fences', () => {
  it('rejects noncanonical commitment storage in every provider authority table', async () => {
    const samsung = await runtimeSamsungLegacyFixture('refresh');
    const db = samsung.kit.env.DB;
    const commitment = await ensureCredentialRefKeyset(db, samsung.kit.env);
    await run(
      db,
      `INSERT INTO wallet_samsung_tombstones
      (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id, provider_identity_hash,
       retired_at, credential_keyset_commitment)
      SELECT ?, c.org_id, c.mode, c.provider_account_id, c.provider_account_revision, c.id, r.id,
        c.provider_identity_hash, ?, ?
      FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?`,
      ['b'.repeat(64), samsung.kit.clock.now(), commitment, samsung.scope.providerReleaseId],
    );
    for (const table of [
      'wallet_provider_instances',
      'wallet_provider_instance_operations',
      'wallet_samsung_fetch_refs',
      'wallet_samsung_tombstones',
      'template_candidates',
      'template_approvals',
      'template_releases',
      'wallet_provider_projection_evidence',
      'wallet_provider_projection_evidence_history',
    ]) {
      await expectCanonicalCommitmentChecks(db, table, commitment);
    }

    const google = await runtimeGoogleLegacyFixture();
    const googleDb = google.kit.env.DB;
    const googleCommitment = await ensureCredentialRefKeyset(googleDb, google.kit.env);
    const guard = await first<{ sql: string }>(
      googleDb,
      `SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'wallet_provider_generation_google_binding'`,
    );
    if (!guard?.sql) throw new Error('Missing Google binding guard');
    // Seed a historical binding without enabling the currently unavailable issuance path.
    await batch(googleDb, [
      stmt(googleDb, 'DROP TRIGGER wallet_provider_generation_google_binding'),
      stmt(
        googleDb,
        `INSERT INTO wallet_google_callback_bindings
        (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
          google.instanceId,
          google.scope.accountId,
          'c'.repeat(64),
          'd'.repeat(64),
          google.kit.clock.now(),
          googleCommitment,
        ],
      ),
      stmt(googleDb, guard.sql),
    ]);
    await expectCanonicalCommitmentChecks(
      googleDb,
      'wallet_google_callback_bindings',
      googleCommitment,
    );
  }, 120_000);

  it('stages blocked targets only after the reserved credential CAS', async () => {
    const { db, pass, f, credentialKeysetCommitment } = await fixture();
    await expect(
      run(db, 'UPDATE passes SET credential_generation = credential_generation + 1 WHERE id = ?', [
        pass.id,
      ]),
    ).rejects.toThrow();
    expect(await instances(db, pass.id)).toEqual([]);
    const statements = startStatements(db, pass.id, crypto.randomUUID(), f.clock.now());
    await statements[0]!.run();
    expect(
      await first(db, 'SELECT credential_generation FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ credential_generation: 1 });
    expect(await instances(db, pass.id)).toEqual([]);
    await expect(
      run(
        db,
        `INSERT INTO wallet_provider_instances
      (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at,
       credential_keyset_commitment)
      SELECT ?, id, org_id, mode, 'google', credential_generation + 1, 'blocked', 0, ?, ?, ?
      FROM passes WHERE id = ?`,
        [crypto.randomUUID(), f.clock.now(), f.clock.now(), credentialKeysetCommitment, pass.id],
      ),
    ).rejects.toThrow(/provider issuance is unavailable/);
    await statements[1]!.run();
    expect(
      await first(db, 'SELECT credential_generation FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ credential_generation: 2 });
    expect(
      (await instances(db, pass.id)).map(({ provider, credential_generation, lifecycle }) => ({
        provider,
        credential_generation,
        lifecycle,
      })),
    ).toEqual([
      { provider: 'google', credential_generation: 2, lifecycle: 'blocked' },
      { provider: 'samsung', credential_generation: 2, lifecycle: 'blocked' },
    ]);
  });

  it('rolls back reservation and provider staging when the credential CAS is invalid', async () => {
    const { db, pass, f } = await fixture();
    const transferId = crypto.randomUUID();
    const statements = startStatements(db, pass.id, transferId, f.clock.now());
    await expect(
      batch(db, [
        statements[0]!,
        stmt(
          db,
          `UPDATE passes SET credential_generation = credential_generation + 1, download_token = ?
        WHERE id = ?`,
          [crypto.randomUUID(), pass.id],
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await first(db, 'SELECT id FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).toBeNull();
    expect(
      await first(db, 'SELECT credential_generation FROM passes WHERE id = ?', [pass.id]),
    ).toEqual({ credential_generation: 1 });
    expect(await instances(db, pass.id)).toEqual([]);
  });

  it('reserves pristine targets until durable completion and then permits only ready placeholders', async () => {
    const { db, pass, f, credentialKeysetCommitment } = await fixture();
    const now = f.clock.now();
    const transferId = await start(db, pass.id, now);
    const target = await instances(db, pass.id);
    expect(
      target.map(({ provider, credential_generation, lifecycle }) => ({
        provider,
        credential_generation,
        lifecycle,
      })),
    ).toEqual([
      { provider: 'google', credential_generation: 2, lifecycle: 'blocked' },
      { provider: 'samsung', credential_generation: 2, lifecycle: 'blocked' },
    ]);
    for (const instance of target) {
      await expect(
        run(db, "UPDATE wallet_provider_instances SET lifecycle = 'ready' WHERE id = ?", [
          instance.id,
        ]),
      ).rejects.toThrow(/provider generation is blocked/);
      await expect(
        run(
          db,
          `UPDATE wallet_provider_instances SET lifecycle = 'retired', retirement_reason = 'not_issued',
        retired_at = ? WHERE id = ?`,
          [now, instance.id],
        ),
      ).rejects.toThrow(/pending provider target cannot retire/);
      await expect(
        run(db, 'UPDATE wallet_provider_instances SET retirement_requested_at = ? WHERE id = ?', [
          now,
          instance.id,
        ]),
      ).rejects.toThrow(/pending provider target cannot retire/);
      await expect(
        run(db, 'UPDATE wallet_provider_instances SET credential_generation = 1 WHERE id = ?', [
          instance.id,
        ]),
      ).rejects.toThrow(/immutable/);
    }
    await expect(
      run(
        db,
        `INSERT OR REPLACE INTO wallet_provider_instances
      (id, pass_id, org_id, mode, provider, credential_generation, lifecycle, desired_version, created_at, updated_at,
       credential_keyset_commitment)
      SELECT ?, id, org_id, mode, 'google', credential_generation, 'blocked', 0, ?, ?, ? FROM passes WHERE id = ?`,
        [crypto.randomUUID(), now, now, credentialKeysetCommitment, pass.id],
      ),
    ).rejects.toThrow(/provider issuance is unavailable/);
    expect(await instances(db, pass.id)).toEqual(target);
    await finish(db, pass.id, transferId, now + 1);
    expect(
      await first(db, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).toEqual({ state: 'completed' });
    const completed = await instances(db, pass.id);
    expect(completed.map(({ id, provider, lifecycle }) => ({ id, provider, lifecycle }))).toEqual(
      target.map((row) => ({ id: row.id, provider: row.provider, lifecycle: 'ready' })),
    );
    for (const instance of completed) {
      await expect(
        run(db, "UPDATE wallet_provider_instances SET lifecycle = 'active' WHERE id = ?", [
          instance.id,
        ]),
      ).rejects.toThrow(/provider issuance is unavailable/);
      await expect(
        run(db, "UPDATE wallet_provider_instances SET lifecycle = 'blocked' WHERE id = ?", [
          instance.id,
        ]),
      ).rejects.toThrow(/provider generation cannot be reblocked/);
    }
    const nextTransfer = await start(db, pass.id, now + 2);
    const next = await instances(db, pass.id);
    expect(
      next.map(({ provider, credential_generation, lifecycle, retirement_reason }) => ({
        provider,
        credential_generation,
        lifecycle,
        retirement_reason,
      })),
    ).toEqual([
      {
        provider: 'google',
        credential_generation: 2,
        lifecycle: 'retired',
        retirement_reason: 'not_issued',
      },
      {
        provider: 'samsung',
        credential_generation: 2,
        lifecycle: 'retired',
        retirement_reason: 'not_issued',
      },
      {
        provider: 'google',
        credential_generation: 3,
        lifecycle: 'blocked',
        retirement_reason: null,
      },
      {
        provider: 'samsung',
        credential_generation: 3,
        lifecycle: 'blocked',
        retirement_reason: null,
      },
    ]);
    expect(
      await first(
        db,
        `SELECT COUNT(*) AS n FROM wallet_provider_retirement_complete done
      JOIN wallet_provider_instances i ON i.id = done.id WHERE i.pass_id = ?`,
        [pass.id],
      ),
    ).toEqual({ n: 2 });
    await finish(db, pass.id, nextTransfer, now + 3);
    expect(
      (await instances(db, pass.id))
        .filter((row) => row.credential_generation === 3)
        .map(({ provider, lifecycle }) => ({ provider, lifecycle })),
    ).toEqual([
      { provider: 'google', lifecycle: 'ready' },
      { provider: 'samsung', lifecycle: 'ready' },
    ]);
  });

  it('fences stale revoke snapshots and allows retirement work only under current pass authority', async () => {
    const historical = await runtimeSamsungLegacyFixture('refresh');
    const { kit, pass, instanceId } = historical;
    const db = kit.env.DB;
    const oldGeneration = historical.snapshot.credentialGeneration;
    const transferId = crypto.randomUUID();
    const statements = startStatements(db, pass.id, transferId, kit.clock.now());
    await statements[0]!.run();
    expect(
      await first(
        db,
        `SELECT lifecycle, retirement_requested_at FROM wallet_provider_instances WHERE id = ?`,
        [instanceId],
      ),
    ).toEqual({ lifecycle: 'active', retirement_requested_at: null });
    const nextGeneration = oldGeneration + 1;
    const operationId = crypto.randomUUID();
    const insertRevoke = (generation: number) =>
      run(
        db,
        `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
       policy_revision, created_at, credential_keyset_commitment)
      SELECT ?, i.id, 2, 'revoke', ?, p.version, p.revision, ?, p.lifecycle_generation,
        p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision, ?, i.credential_keyset_commitment
      FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
      JOIN wallet_provider_accounts a ON a.id = i.account_id
      JOIN template_releases r ON r.id = i.identity_projection_release_id WHERE i.id = ?`,
        [operationId, 'f'.repeat(64), generation, kit.clock.now(), instanceId],
      );
    await expect(insertRevoke(oldGeneration)).rejects.toThrow(
      /provider operation is not authorized/,
    );
    await statements[1]!.run();
    expect(
      await first(
        db,
        `SELECT lifecycle, retirement_requested_at FROM wallet_provider_instances WHERE id = ?`,
        [instanceId],
      ),
    ).toEqual({ lifecycle: 'active', retirement_requested_at: kit.clock.now() });
    await expect(insertRevoke(oldGeneration)).rejects.toThrow(
      /provider operation is not authorized/,
    );
    expect(
      await first(db, 'SELECT id FROM wallet_provider_instance_operations WHERE id = ?', [
        operationId,
      ]),
    ).toBeNull();
    await insertRevoke(nextGeneration);
    expect(
      await first(
        db,
        `SELECT pass_credential_generation, kind FROM wallet_provider_instance_operations WHERE id = ?`,
        [operationId],
      ),
    ).toEqual({ pass_credential_generation: nextGeneration, kind: 'revoke' });
    await expect(finish(db, pass.id, transferId, kit.clock.now() + 1)).rejects.toThrow();
    expect(
      await first(db, 'SELECT state FROM pass_credential_transfers WHERE id = ?', [transferId]),
    ).toEqual({ state: 'pending' });
    expect(await first(db, 'SELECT holder_email FROM passes WHERE id = ?', [pass.id])).toEqual({
      holder_email: pass.holderEmail,
    });
  }, 120_000);

  it('blocks unsettled deletion and prevents pass replacement', async () => {
    const historical = await runtimeSamsungLegacyFixture('refresh');
    const { kit, scope } = historical;
    const db = kit.env.DB;
    const pass = await kit.pass();
    const instanceId = crypto.randomUUID();
    const upsertId = crypto.randomUUID();
    const revokeId = crypto.randomUUID();
    const now = kit.clock.now();
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, kit.env);
    await seedHistoricalProviderInstance(db, {
      id: instanceId,
      operationId: upsertId,
      passId: pass.id,
      orgId: pass.orgId,
      mode: pass.mode,
      provider: 'samsung',
      credentialGeneration: pass.credentialGeneration,
      accountId: scope.accountId,
      releaseId: scope.providerReleaseId,
      now,
      credentialKeysetCommitment,
      upsert: { requestHash: '1'.repeat(64), state: 'succeeded' },
    });
    await run(
      db,
      `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
       policy_revision, state, created_at, credential_keyset_commitment)
      SELECT ?, i.id, 2, 'revoke', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
        p.release_id, r.id, a.revision, r.adapter_revision, r.audience_policy_revision, 'succeeded', ?, i.credential_keyset_commitment
      FROM wallet_provider_instances i JOIN passes p ON p.id = i.pass_id
      JOIN wallet_provider_accounts a ON a.id = i.account_id
      JOIN template_releases r ON r.id = i.identity_projection_release_id WHERE i.id = ?`,
      [revokeId, '2'.repeat(64), now, instanceId],
    );
    await expect(
      run(
        db,
        `INSERT INTO wallet_provider_instance_operations
      SELECT * FROM wallet_provider_instance_operations WHERE id = ?`,
        [upsertId],
      ),
    ).rejects.toThrow(/provider operation history is immutable/);
    for (const [id, version, hash] of [
      [upsertId, 3, '3'.repeat(64)],
      [crypto.randomUUID(), 1, '4'.repeat(64)],
      [crypto.randomUUID(), 3, '1'.repeat(64)],
    ] as const) {
      await expect(
        run(
          db,
          `INSERT OR REPLACE INTO wallet_provider_instance_operations
        (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
         lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
         policy_revision, state, created_at, credential_keyset_commitment)
        SELECT ?, instance_id, ?, kind, ?, pass_version, pass_revision, pass_credential_generation,
          lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
          policy_revision, 'pending', created_at, credential_keyset_commitment FROM wallet_provider_instance_operations WHERE id = ?`,
          [id, version, hash, upsertId],
        ),
      ).rejects.toThrow(/provider operation history is immutable/);
    }
    await expect(
      run(db, 'UPDATE OR REPLACE wallet_provider_instance_operations SET id = ? WHERE id = ?', [
        revokeId,
        upsertId,
      ]),
    ).rejects.toThrow(/provider operation history is immutable/);
    await run(
      db,
      `UPDATE wallet_provider_instance_operations SET state = 'claimed',
      claim_hash = ?, claim_expires_at = ? WHERE id = ?`,
      ['5'.repeat(64), now + 1000, upsertId],
    );
    await expect(
      run(
        db,
        `INSERT OR REPLACE INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
       policy_revision, state, claim_hash, claim_expires_at, created_at, credential_keyset_commitment)
      SELECT ?, instance_id, 3, kind, ?, pass_version, pass_revision, pass_credential_generation,
        lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
        policy_revision, 'claimed', ?, ?, created_at, credential_keyset_commitment FROM wallet_provider_instance_operations WHERE id = ?`,
        [crypto.randomUUID(), '6'.repeat(64), '7'.repeat(64), now + 1000, upsertId],
      ),
    ).rejects.toThrow(/provider operation history is immutable/);
    await expect(
      run(
        db,
        `UPDATE OR REPLACE wallet_provider_instance_operations
      SET state = 'claimed', claim_hash = ?, claim_expires_at = ? WHERE id = ?`,
        ['8'.repeat(64), now + 1000, revokeId],
      ),
    ).rejects.toThrow(/provider operation history is immutable/);
    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'uncertain' WHERE id = ?",
      [upsertId],
    );
    await run(db, "UPDATE wallet_provider_instance_operations SET state = 'retry' WHERE id = ?", [
      upsertId,
    ]);
    await run(
      db,
      `UPDATE wallet_provider_instances SET retirement_requested_at = ?, lifecycle = 'revoking',
      desired_version = 2, desired_operation_id = ? WHERE id = ?`,
      [now, revokeId, instanceId],
    );
    await run(db, "UPDATE wallet_provider_instances SET lifecycle = 'revoked' WHERE id = ?", [
      instanceId,
    ]);
    await run(
      db,
      "UPDATE wallet_provider_instances SET lifecycle = 'retired', retired_at = ? WHERE id = ?",
      [now, instanceId],
    );
    expect(
      await first(db, 'SELECT id FROM wallet_provider_retirement_complete WHERE id = ?', [
        instanceId,
      ]),
    ).toBeNull();
    await expect(
      run(db, 'DELETE FROM wallet_provider_instance_operations WHERE id = ?', [upsertId]),
    ).rejects.toThrow(/provider operation history is retained/);
    await expect(
      run(db, 'DELETE FROM wallet_provider_instances WHERE id = ?', [instanceId]),
    ).rejects.toThrow(/provider/);
    await expect(run(db, 'DELETE FROM passes WHERE id = ?', [pass.id])).rejects.toThrow(/provider/);
    await expect(
      run(db, 'INSERT OR REPLACE INTO passes SELECT * FROM passes WHERE id = ?', [pass.id]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    const other = await kit.pass();
    await expect(
      run(db, 'UPDATE OR REPLACE passes SET download_token = ? WHERE id = ?', [
        pass.downloadToken,
        other.id,
      ]),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toEqual({
      id: pass.id,
    });
    await run(
      db,
      "UPDATE wallet_provider_instance_operations SET state = 'superseded' WHERE id = ?",
      [upsertId],
    );
    expect(
      await first(db, 'SELECT id FROM wallet_provider_retirement_complete WHERE id = ?', [
        instanceId,
      ]),
    ).toEqual({ id: instanceId });
    await run(db, 'DELETE FROM passes WHERE id = ?', [pass.id]);
    expect(await first(db, 'SELECT id FROM passes WHERE id = ?', [pass.id])).toBeNull();
  }, 120_000);

  it('keeps historical Samsung reference hashes and instance bindings immutable', async () => {
    const historical = await runtimeSamsungLegacyFixture('refresh');
    const { kit, scope, instanceId, refHash, refRow } = historical;
    const db = kit.env.DB;
    const credentialKeysetCommitment = await ensureCredentialRefKeyset(db, kit.env);
    const retiredHash = 'b'.repeat(64);
    await run(
      db,
      `INSERT INTO wallet_samsung_tombstones
      (ref_hash, org_id, mode, account_id, account_revision, candidate_id, release_id, provider_identity_hash,
       retired_at, credential_keyset_commitment)
      SELECT ?, c.org_id, c.mode, c.provider_account_id, c.provider_account_revision, c.id, r.id,
        c.provider_identity_hash, ?, ?
      FROM template_releases r JOIN template_candidates c ON c.id = r.candidate_id WHERE r.id = ?`,
      [retiredHash, kit.clock.now(), credentialKeysetCommitment, scope.providerReleaseId],
    );
    await expect(
      run(db, 'UPDATE wallet_samsung_fetch_refs SET id = ? WHERE id = ?', [
        crypto.randomUUID(),
        refRow,
      ]),
    ).rejects.toThrow(/provider artifact identity is immutable/);
    await expect(
      run(db, 'UPDATE wallet_samsung_fetch_refs SET ref_hash = ? WHERE id = ?', [
        retiredHash,
        refRow,
      ]),
    ).rejects.toThrow(/provider artifact identity is immutable/);
    await expect(
      run(db, 'UPDATE wallet_samsung_fetch_refs SET instance_id = ? WHERE id = ?', [
        crypto.randomUUID(),
        refRow,
      ]),
    ).rejects.toThrow(/provider artifact identity is immutable/);
    await expect(
      run(db, 'DELETE FROM wallet_samsung_fetch_refs WHERE id = ?', [refRow]),
    ).rejects.toThrow(/Samsung reference history is retained/);
    expect(
      await first(db, 'SELECT ref_hash, instance_id FROM wallet_samsung_fetch_refs WHERE id = ?', [
        refRow,
      ]),
    ).toEqual({ ref_hash: refHash, instance_id: instanceId });
    const retiredRow = crypto.randomUUID();
    const oldRef = createSamsungRefId();
    const now = kit.clock.now();
    const envelope = await encryptSecret(
      await loadKekRing(kit.env),
      oldRef,
      credentialAad(
        retiredRow,
        historical.pass.orgId,
        `samsung-ref|${historical.pass.mode}|${instanceId}`,
      ),
    );
    await seedHistoricalSamsungRef(db, {
      id: retiredRow,
      refHash: await sha256Hex(oldRef),
      instanceId,
      createdAt: now,
      initialExpiresAt: now + 300_000,
      promotedAt: null,
      retiredAt: now,
      envelope,
      credentialKeysetCommitment,
    });
    await expect(
      run(db, 'UPDATE OR REPLACE wallet_samsung_fetch_refs SET retired_at = NULL WHERE id = ?', [
        retiredRow,
      ]),
    ).rejects.toThrow(/Samsung reference retirement is immutable/);
    await expect(
      run(db, 'UPDATE wallet_samsung_fetch_refs SET retired_at = ? WHERE id = ?', [
        now + 1,
        retiredRow,
      ]),
    ).rejects.toThrow(/Samsung reference retirement is immutable/);
    expect(
      await first(db, 'SELECT id FROM wallet_samsung_fetch_refs WHERE id = ?', [refRow]),
    ).toEqual({ id: refRow });
  }, 120_000);

  it.each(['google', 'samsung'] as const)(
    'denies direct %s issuance without a verifiable provider gate',
    async (provider) => {
      const { db, pass, f, credentialKeysetCommitment } = await fixture();
      await expect(
        run(
          db,
          `INSERT INTO wallet_provider_instances
      (id, pass_id, org_id, mode, provider, account_id, identity_projection_release_id,
       credential_generation, lifecycle, desired_version, desired_operation_id, created_at, updated_at, credential_keyset_commitment)
      SELECT ?, id, org_id, mode, ?, 'unverified-account', 'unverified-release',
        credential_generation, 'active', 1, 'unverified-operation', ?, ?, ? FROM passes WHERE id = ?`,
          [
            crypto.randomUUID(),
            provider,
            f.clock.now(),
            f.clock.now(),
            credentialKeysetCommitment,
            pass.id,
          ],
        ),
      ).rejects.toThrow(/provider issuance is unavailable/);
      expect(await instances(db, pass.id)).toEqual([]);
    },
  );

  it('does not allow operations, offers, or provider references on pending placeholders', async () => {
    const { db, pass, f, credentialKeysetCommitment } = await fixture();
    const now = f.clock.now();
    await start(db, pass.id, now);
    const target = await instances(db, pass.id);
    const google = target.find((row) => row.provider === 'google')!;
    const samsung = target.find((row) => row.provider === 'samsung')!;
    await expect(
      run(
        db,
        `INSERT INTO wallet_provider_instance_operations
      (id, instance_id, version, kind, request_hash, pass_version, pass_revision, pass_credential_generation,
       lifecycle_generation, issuing_release_id, projection_release_id, account_revision, adapter_revision,
       policy_revision, created_at, credential_keyset_commitment)
      VALUES (?, ?, 1, 'upsert', ?, 1, 0, 2, 0, 'unverified-release', 'unverified-release', 1, 1, 1, ?, ?)`,
        [crypto.randomUUID(), samsung.id, 'a'.repeat(64), now, credentialKeysetCommitment],
      ),
    ).rejects.toThrow(/provider operation/);
    await expect(
      run(
        db,
        `INSERT INTO wallet_provider_offer_refs
      (ref_hash, instance_id, operation_version, created_at, expires_at) VALUES (?, ?, 1, ?, ?)`,
        ['b'.repeat(64), samsung.id, now, now + 1000],
      ),
    ).rejects.toThrow(/provider offer is unavailable/);
    await expect(
      run(
        db,
        `INSERT INTO wallet_samsung_fetch_refs
      (id, ref_hash, instance_id, created_at, last_offered_at, initial_expires_at, kek_version, iv, wrapped_dek, ciphertext,
       credential_keyset_commitment)
      VALUES (?, ?, ?, ?, ?, ?, 1, x'01', x'02', x'03', ?)`,
        [
          crypto.randomUUID(),
          'c'.repeat(64),
          samsung.id,
          now,
          now,
          now + 1000,
          credentialKeysetCommitment,
        ],
      ),
    ).rejects.toThrow(/provider reference is unavailable/);
    await expect(
      run(
        db,
        `INSERT INTO wallet_google_callback_bindings
      (instance_id, account_id, class_id_hash, object_id_hash, created_at, credential_keyset_commitment)
      VALUES (?, 'unverified-account', ?, ?, ?, ?)`,
        [google.id, 'd'.repeat(64), 'e'.repeat(64), now, credentialKeysetCommitment],
      ),
    ).rejects.toThrow(/provider binding is not authorized/);
    expect(await instances(db, pass.id)).toEqual(target);
  });
});
