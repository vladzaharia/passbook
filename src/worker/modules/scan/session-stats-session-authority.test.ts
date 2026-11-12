import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { run } from '../../platform/db.ts';
import { scanningSessionStats } from './repo-scanning-sessions.ts';
import {
  atCountBatch,
  freshFixture,
  insertExistingReference,
  singleton,
} from './repo-session-stats-authority-test-fixtures.ts';
import { sessionDto } from './scanning-session-dto.ts';

const makeEnv = installKeysetTestEnv();

describe('scanning session count authority', () => {
  it('rejects a wrong-mode detail as generic not-found without initializing', async () => {
    const f = await freshFixture(await makeEnv());
    const response = await f.request(`/scanning-sessions/${f.id}`, {
      ...f.browser.headers,
      'x-passbook-mode': 'test',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'SCANNING_SESSION_NOT_FOUND' });
    expect(await singleton(f)).toBeNull();
  });

  it('does not bootstrap for a proof bound to another tenant, mode or device session', async () => {
    const f = await freshFixture(await makeEnv());
    const proofs = [
      { ...f.proof, orgId: f.fx.ids.id() },
      { ...f.proof, mode: 'test' as const },
      { ...f.proof, sessionId: f.fx.ids.id() },
    ];
    for (const proof of proofs) {
      expect(
        await scanningSessionStats(
          f.env.DB,
          f.row,
          f.clock.now() - 86_400_000,
          f.clock.now() - 120_000,
          proof,
          f.clock.now(),
        ),
      ).toBeNull();
      expect(await singleton(f)).toBeNull();
    }
  });

  it.each(['membership', 'session revoked', 'org suspended', 'mode'] as const)(
    'does not initialize or return counts when %s changes at the guarded transaction',
    async (change) => {
      const f = await freshFixture(await makeEnv());
      const race = () =>
        atCountBatch(
          f.env,
          () => f.request(`/scanning-sessions/${f.id}`),
          async (db) => {
            if (change === 'membership')
              await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
                f.clock.now(),
                f.membershipId,
              ]);
            if (change === 'session revoked')
              await run(db, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
                f.clock.now(),
                f.auth.sessionId,
              ]);
            if (change === 'org suspended')
              await run(db, "UPDATE orgs SET status='suspended' WHERE id=?", [f.org.id]);
            if (change === 'mode')
              await run(db, "UPDATE scanning_sessions SET mode='test' WHERE id=?", [f.id]);
          },
        );
      const { result } = await race();
      expect(result.status).toBe(404);
      expect(await result.json()).toMatchObject({ code: 'SCANNING_SESSION_NOT_FOUND' });
      expect(await singleton(f)).toBeNull();
    },
  );

  // A rename, a revision, an org settings save and the (fixed) CSRF secret are not authority.
  it.each([
    ['session name', "UPDATE scanning_sessions SET name='Changed session' WHERE id=?", 'session'],
    [
      'session revision',
      'UPDATE scanning_sessions SET updated_at=updated_at+1 WHERE id=?',
      'session',
    ],
    ['org revision', 'UPDATE orgs SET updated_at=updated_at+1 WHERE id=?', 'org'],
  ] as const)(
    'still counts when the %s changes at the guarded transaction',
    async (_name, sql, target) => {
      const f = await freshFixture(await makeEnv());
      const { result } = await atCountBatch(
        f.env,
        () => f.request(`/scanning-sessions/${f.id}`),
        async (db) => {
          await run(db, sql, [target === 'org' ? f.org.id : f.id]);
        },
      );
      expect(result.status).toBe(200);
    },
  );

  it('rechecks the session expiration at the count batch, not at proof capture', async () => {
    const f = await freshFixture(await makeEnv());
    f.clock.advance(3_600_001);
    await expect(sessionDto(f.ctx, f.row, f.proof)).rejects.toMatchObject({
      code: 'SCANNING_SESSION_NOT_FOUND',
    });
    expect(await singleton(f)).toBeNull();
  });

  // Reads carry no credential keyset, so a different one moves nothing and counts are plain.
  it('counts normally when the original keyset differs', async () => {
    const f = await freshFixture(await makeEnv());
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await run(f.env.DB, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [other]);
    await expect(sessionDto(f.ctx, f.row, f.proof)).resolves.toMatchObject({ id: f.id });
    const response = await f.request(`/scanning-sessions/${f.id}`);
    expect(response.status).toBe(200);
    expect(await singleton(f)).toEqual({ commitment: other });
  });

  it('does not disclose keyset availability after the captured membership is revoked', async () => {
    const f = await freshFixture(await makeEnv());
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await run(f.env.DB, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [other]);
    await run(f.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      f.clock.now(),
      f.membershipId,
    ]);
    await expect(sessionDto(f.ctx, f.row, f.proof)).rejects.toMatchObject({
      code: 'SCANNING_SESSION_NOT_FOUND',
    });
    expect(await singleton(f)).toEqual({ commitment: other });
  });

  it('counts normally when another keyset appears immediately before the count batch', async () => {
    const f = await freshFixture(await makeEnv());
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const { result } = await atCountBatch(
      f.env,
      () =>
        scanningSessionStats(
          f.env.DB,
          f.row,
          f.clock.now() - 86_400_000,
          f.clock.now() - 120_000,
          f.proof,
          f.clock.now(),
        ),
      async (db) => {
        await run(db, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [other]);
      },
    );
    expect(result).toEqual({ devices: 0, online: 0, today: 0 });
    expect(await singleton(f)).toEqual({ commitment: other });
  });

  it('counts without recreating a missing singleton when retained credential references exist', async () => {
    const f = await freshFixture(await makeEnv());
    await insertExistingReference(f);
    await expect(sessionDto(f.ctx, f.row, f.proof)).resolves.toMatchObject({ id: f.id });
    const response = await f.request(`/scanning-sessions?orgId=${f.org.id}`);
    expect(response.status).toBe(200);
    expect(await singleton(f)).toBeNull();
  });
});
