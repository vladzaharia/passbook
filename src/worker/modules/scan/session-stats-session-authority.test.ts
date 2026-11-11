import { describe, expect, it } from 'vitest';
import { installKeysetTestEnv } from '../../../../test/helpers/credential-keyset.ts';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { scanningSessionStats } from './repo-scanning-sessions.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import {
  atCountBatch,
  freshFixture,
  insertExistingReference,
  singleton,
} from './repo-session-stats-authority-test-fixtures.ts';
import { sessionDto } from './scanning-session-dto.ts';

const makeEnv = installKeysetTestEnv();

function countResultIndexes(statements: readonly ({ sql: string } | undefined)[]) {
  const initialize = statements.findIndex((entry) =>
    /INSERT\s+INTO\s+credential_ref_keyset/i.test(entry?.sql ?? ''),
  );
  const authority = statements.findIndex((entry) =>
    /WITH\s+session_scope\s+AS\s+MATERIALIZED\s*\(/i.test(entry?.sql ?? ''),
  );
  const devices = statements.findIndex((entry) =>
    /SELECT\s+count\(\*\)\s+AS\s+devices\b/i.test(entry?.sql ?? ''),
  );
  const today = statements.findIndex((entry) =>
    /SELECT\s+count\(\*\)\s+AS\s+n\s+FROM\s+scans\s+s\b/i.test(entry?.sql ?? ''),
  );
  expect(statements).toHaveLength(4);
  if ([initialize, authority, devices, today].some((index) => index < 0))
    throw new Error('Missing a session stats batch statement');
  expect(new Set([initialize, authority, devices, today]).size).toBe(4);
  return { initialize, authority, devices, today };
}

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

  it('fails closed rather than returning zero if the original keyset differs', async () => {
    const f = await freshFixture(await makeEnv());
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await run(f.env.DB, 'INSERT INTO credential_ref_keyset (id,commitment) VALUES (1,?)', [other]);
    await expect(sessionDto(f.ctx, f.row, f.proof)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    const response = await f.request(`/scanning-sessions/${f.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
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

  it('does not count if another keyset wins immediately before the bootstrap batch', async () => {
    const f = await freshFixture(await makeEnv());
    const other =
      f.proof.credentialKeysetCommitment === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    await expect(
      atCountBatch(
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
      ),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await singleton(f)).toEqual({ commitment: other });
  });

  it('never recreates a missing singleton when retained credential references exist', async () => {
    const f = await freshFixture(await makeEnv());
    await insertExistingReference(f);
    await expect(sessionDto(f.ctx, f.row, f.proof)).rejects.toMatchObject({
      code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE',
    });
    const response = await f.request(`/scanning-sessions?orgId=${f.org.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await singleton(f)).toBeNull();
  });

  it('also fails unavailable when a retained scan event proof survives singleton loss', async () => {
    const f = await freshFixture(await makeEnv());
    const template = makeTemplate({ id: f.fx.ids.id(), orgId: f.org.id });
    const pass = await makePass(f.fx, { orgId: f.org.id, template: template.resolved });
    await run(
      f.env.DB,
      `INSERT INTO pass_events (id,org_id,pass_id,mode,kind,data,at)
      VALUES (?,?,?,'live','scan.checked_in',?,?)`,
      [
        f.fx.ids.id(),
        f.org.id,
        pass.id,
        JSON.stringify({ authority: { credentialKeysetCommitment: 'f'.repeat(64) } }),
        f.clock.now(),
      ],
    );
    const response = await f.request(`/scanning-sessions/${f.id}`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'CREDENTIAL_REF_KEYSET_UNAVAILABLE' });
    expect(await singleton(f)).toBeNull();
  });

  it('keeps session identifiers, CSRF secrets and private session fields in labeled scalar binds', async () => {
    const f = await freshFixture(await makeEnv());
    const { result, captured } = await atCountBatch(
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
      async () => {},
    );
    expect(result).toEqual({ devices: 0, online: 0, today: 0 });
    const indexes = countResultIndexes(captured);
    const initialize = captured[indexes.initialize];
    const select = captured[indexes.authority];
    const devices = captured[indexes.devices];
    const today = captured[indexes.today];
    if (!select || !initialize || !devices || !today)
      throw new Error('Missing same-batch keyset or count statement');
    expect(select.sql).not.toMatch(/\bAS\s+(?:devices|online|n)\b/i);
    expect(devices.sql).toMatch(/\bAS\s+online\b/i);
    for (const entry of [initialize, select]) {
      const slots = scanSecretSlots(entry.sql, entry.params.length);
      if (!slots) throw new Error('Malformed count bind labels');
      for (const [secret, labels] of [
        [f.auth.sessionId, ['session-id', 'session-id-hash']],
        [f.browser.csrf, ['csrf:actor:session']],
        [f.id, ['session-id']],
        [f.proof.credentialKeysetCommitment, ['proof']],
      ] as const) {
        const indexes = entry.params.flatMap((value, index) => (value === secret ? [index] : []));
        expect(indexes.length).toBeGreaterThan(0);
        for (const index of indexes) expect(labels).toContain(slots[index]?.label);
        for (const value of entry.params) {
          if (
            typeof value === 'string' &&
            value !== secret &&
            (value.startsWith('[') || value.startsWith('{'))
          )
            expect(value).not.toContain(secret);
        }
      }
    }
  });
});
