import { describe, expect, it } from 'vitest';
import {
  envA,
  envB,
  expectKeysetInitializationBlocked,
  installKeysetTestEnv,
} from '../../../../test/helpers/credential-keyset.ts';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import {
  fixtures,
  makeOrg,
  makePass,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { credentialRefKeysetCommitment, ensureCredentialRefKeyset } from './credential-keyset.ts';

const makeEnv = installKeysetTestEnv();

describe.sequential('credential keyset provider history', () => {
  it('fails closed when provider instances survive a forcibly removed singleton', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const { resolved: template, registry } = makeTemplate();
    const pass = await makePass(f, { orgId: org.id, template, registry });
    const db = f.env.DB;
    await ensureCredentialRefKeyset(db, envA);
    await stagePendingCredentialTransfer(db, pass.id, {
      id: f.ids.id(),
      token: f.ids.token(),
      now: f.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    expect(
      await first(db, 'SELECT COUNT(*) AS n FROM wallet_provider_instances WHERE pass_id = ?', [
        pass.id,
      ]),
    ).toEqual({ n: 2 });
    await expect(
      run(db, "UPDATE wallet_provider_instances SET lifecycle = 'ready' WHERE pass_id = ?", [
        pass.id,
      ]),
    ).rejects.toThrow('provider generation is blocked');
    expect(
      await first(
        db,
        "SELECT COUNT(*) AS n FROM wallet_provider_instances WHERE pass_id = ? AND lifecycle = 'blocked'",
        [pass.id],
      ),
    ).toEqual({ n: 2 });
    await run(db, 'DROP TRIGGER credential_ref_keyset_no_delete');
    try {
      await run(db, 'DELETE FROM credential_ref_keyset WHERE id = 1');
      await expectKeysetInitializationBlocked(db, envB);
    } finally {
      await run(
        db,
        `CREATE TRIGGER credential_ref_keyset_no_delete BEFORE DELETE ON credential_ref_keyset
        BEGIN SELECT RAISE(ABORT, 'credential reference keyset is immutable'); END`,
      );
    }
  });

  it('allows bootstrap with a provider account but no retained authority', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    await run(
      f.env.DB,
      `INSERT INTO wallet_provider_accounts
      (id, org_id, mode, provider, created_at, updated_at) VALUES ('account', ?, 'live', 'google', 1, 1)`,
      [org.id],
    );
    expect(await ensureCredentialRefKeyset(f.env.DB, envA)).toBe(
      await credentialRefKeysetCommitment(envA),
    );
  });

  it.each([
    ['apple', null],
    ['apple', 'candidate'],
    ['apple', 'approval'],
    ['apple', 'release'],
    ['google', null],
    ['samsung', null],
  ] as const)(
    'only bootstraps without native or committed projection history: %s %s',
    async (provider, proofAt) => {
      const f = fixtures(await makeEnv());
      const org = await makeOrg(f);
      const { resolved: template, registry } = makeTemplate({ orgId: org.id });
      const db = f.env.DB;
      await persistTemplate(f, template, { registry });
      const guards =
        provider === 'apple'
          ? []
          : await all<{ name: string; sql: string }>(
              db,
              `SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
         AND name IN ('template_provider_candidates_insert', 'wallet_provider_candidate_keyset_insert')`,
            );
      if (provider !== 'apple') expect(guards).toHaveLength(2);
      // Model native projection history that predates the keyset guard.
      for (const guard of guards) await run(db, `DROP TRIGGER "${guard.name}"`);
      try {
        await run(
          db,
          `INSERT INTO template_candidates
          (id, template_id, org_id, mode, provider, version, candidate_hash, content_hash,
           adapter_revision, adapter_capabilities, audience_policy_revision, author_id, created_at, credential_keyset_commitment)
          VALUES ('candidate', ?, ?, 'live', ?, ?, ?, ?, 1, '["apple-passkit"]', 1, 'author', 1, ?)`,
          [
            template.id,
            org.id,
            provider,
            template.version,
            'a'.repeat(64),
            'b'.repeat(64),
            proofAt === 'candidate' ? 'f'.repeat(64) : null,
          ],
        );
      } finally {
        for (const guard of guards) await run(db, guard.sql);
      }
      const assertBlocked = () => expectKeysetInitializationBlocked(db);
      if (provider !== 'apple' || proofAt === 'candidate') {
        await assertBlocked();
        return;
      }
      await run(
        db,
        `INSERT INTO template_approvals
        (id, candidate_id, candidate_hash, reviewer_id, created_at, credential_keyset_commitment)
        VALUES ('approval', 'candidate', ?, 'reviewer', 1, ?)`,
        ['a'.repeat(64), proofAt === 'approval' ? 'f'.repeat(64) : null],
      );
      if (proofAt === 'approval') {
        await assertBlocked();
        return;
      }
      await run(
        db,
        `INSERT INTO template_releases
        (id, template_id, org_id, mode, provider, generation, version, candidate_hash, content_hash,
         adapter_revision, adapter_capabilities, audience_policy_revision, source, action,
         candidate_id, approval_id, created_by, created_at, credential_keyset_commitment)
        VALUES ('release', ?, ?, 'live', 'apple', 1, ?, ?, ?, 1, '["apple-passkit"]', 1,
          'approved', 'release', 'candidate', 'approval', 'reviewer', 1, ?)`,
        [
          template.id,
          org.id,
          template.version,
          'a'.repeat(64),
          'b'.repeat(64),
          proofAt === 'release' ? 'f'.repeat(64) : null,
        ],
      );
      if (proofAt === 'release') {
        await assertBlocked();
        return;
      }
      expect(await ensureCredentialRefKeyset(db, envA)).toBe(
        await credentialRefKeysetCommitment(envA),
      );
    },
  );
});
