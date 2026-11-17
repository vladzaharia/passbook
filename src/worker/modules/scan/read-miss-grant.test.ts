import { beforeAll, describe, expect, it } from 'vitest';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import { first, run } from '../../platform/db.ts';
import { grantReadMiss } from './misses.ts';
import { fixture, kit, setupReadMissGrant, templateId } from './read-miss-grant-test-fixtures.ts';
import { missCounterKey } from './repo-miss-authority.ts';

beforeAll(setupReadMissGrant);

describe('the read miss grant', () => {
  it('counts once per miss and audits the crossing of the cap once', async () => {
    const f = await fixture();
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('counted');
    expect(await f.counter()).toEqual({ count: 1 });
    expect(await f.auditCount()).toEqual({ count: 0 });
    await run(kit.env.DB, 'UPDATE counters SET count=30 WHERE key=? AND window_start=?', [
      f.key,
      f.window,
    ]);
    await expect(grantReadMiss(kit.ctx, f.actor, f.observation)).rejects.toMatchObject({
      code: 'SCAN_TOO_MANY_MISSES',
      status: 429,
    });
    await expect(grantReadMiss(kit.ctx, f.actor, f.observation)).rejects.toMatchObject({
      code: 'SCAN_TOO_MANY_MISSES',
    });
    expect(await f.counter()).toEqual({ count: 32 });
    expect(await f.auditCount()).toEqual({ count: 1 });
    const audit = await first(
      kit.env.DB,
      "SELECT * FROM audit_log WHERE action='scan.misses_capped' AND actor_id=?",
      [f.scanner.id],
    );
    expect(audit).toMatchObject({ detail: null });
    for (const secret of [f.query, f.credentials.credentialTombstoneRefs[0]!])
      expect(JSON.stringify(audit)).not.toContain(secret);
  });

  it.each(['revoked', 'configuration', 'credential'] as const)(
    'counts nothing for a scanner whose %s changed before the count (positive control: it counts first)',
    async (change) => {
      const f = await fixture();
      expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('counted');
      if (change === 'revoked')
        await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          f.scanner.id,
        ]);
      else if (change === 'configuration')
        await run(kit.env.DB, "UPDATE scanners SET time_zone='Europe/Paris' WHERE id=?", [
          f.scanner.id,
        ]);
      else
        await run(
          kit.env.DB,
          'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
          [kit.fx.ids.token(), f.scanner.id],
        );
      expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('not_committed');
      expect(await f.counter()).toEqual({ count: 1 });
    },
  );

  it('counts nothing when the credential was retired in its mode, and ignores the other mode', async () => {
    const f = await fixture();
    const ref = f.credentials.credentialTombstoneRefs[0];
    if (!ref) throw new Error('Missing credential reference');
    const other = await kit.scanPass(templateId, {}, { mode: 'test' });
    const transfer = kit.fx.ids.id();
    await stagePendingCredentialTransfer(kit.env.DB, other.id, {
      id: transfer,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    const retire = (mode: 'test' | 'live', passId: string, id: string) =>
      run(
        kit.env.DB,
        `INSERT INTO pass_credential_tombstones
        (pass_id,org_id,mode,credential_generation,credential_kind,credential_hash,retired_at)
        SELECT pass_id,org_id,?,source_generation,'lookup',?,? FROM pass_credential_transfers
        WHERE id=? AND pass_id=?`,
        [mode, ref, kit.clock.now(), id, passId],
      );
    await retire('test', other.id, transfer);
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('counted');
    const same = await kit.scanPass(templateId);
    const sameTransfer = kit.fx.ids.id();
    await stagePendingCredentialTransfer(kit.env.DB, same.id, {
      id: sameTransfer,
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    await retire('live', same.id, sameTransfer);
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('not_committed');
    expect(await f.counter()).toEqual({ count: 1 });
  });

  it('counts nothing once a pass of the tenant matches, and a pass of another org or mode does not matter', async () => {
    const f = await fixture();
    const elsewhere = await kit.scanPass(templateId, {}, { mode: 'test' });
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [f.query, elsewhere.id]);
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('counted');
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [f.query, pass.id]);
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('not_committed');
    expect(await f.counter()).toEqual({ count: 1 });
    expect(await f.auditCount()).toEqual({ count: 0 });
  });

  it('does not count a miss for a pending transfer on a matching pass either', async () => {
    const f = await fixture();
    const pass = await kit.scanPass(templateId);
    await run(kit.env.DB, 'UPDATE passes SET external_id=? WHERE id=?', [f.query, pass.id]);
    await stagePendingCredentialTransfer(kit.env.DB, pass.id, {
      id: kit.fx.ids.id(),
      token: kit.fx.ids.token(),
      now: kit.clock.now(),
      targetHolderEmail: 'next@example.test',
    });
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('not_committed');
    expect(await f.counter()).toBeNull();
  });

  it('is isolated per tenant, mode and actor: another scanner cannot inflate this one', async () => {
    const a = await fixture();
    const b = await fixture();
    expect(missCounterKey(a.actor)).not.toBe(missCounterKey(b.actor));
    for (let i = 0; i < 3; i++) await grantReadMiss(kit.ctx, b.actor, b.observation);
    expect(await b.counter()).toEqual({ count: 3 });
    expect(await a.counter()).toBeNull();
    // An actor object that names another org cannot write to a counter its principal does not own.
    const forged = { ...a.actor, orgId: 'another-org' };
    await grantReadMiss(kit.ctx, forged, a.observation);
    expect(missCounterKey(forged)).not.toBe(a.key);
    expect(await a.counter()).toBeNull();
  });

  it('keeps a failed counter write from leaving a half-count', async () => {
    const f = await fixture();
    await run(
      kit.env.DB,
      `CREATE TRIGGER read_miss_grant_fail BEFORE INSERT ON counters
      WHEN NEW.key LIKE 'scan:miss:%' BEGIN SELECT RAISE(ABORT, 'counter failed'); END`,
    );
    try {
      await expect(grantReadMiss(kit.ctx, f.actor, f.observation)).rejects.toThrow(
        'counter failed',
      );
      expect(await f.counter()).toBeNull();
    } finally {
      await run(kit.env.DB, 'DROP TRIGGER read_miss_grant_fail');
    }
    expect(await grantReadMiss(kit.ctx, f.actor, f.observation)).toBe('counted');
  });
});
