import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { isPassHeld, listHolds, placeHold, releaseHold } from './holds.ts';
import { closeHold } from './repo-holds.ts';
import { type RetentionKit, retentionKit } from './retention-test-fixtures.ts';

let rk: RetentionKit;
beforeAll(async () => {
  rk = await retentionKit();
});

const ctx = () => rk.kit.ctx;
const orgBy = (o: Awaited<ReturnType<RetentionKit['org']>>) => ({
  kind: 'org' as const,
  authority: o.authority,
});
const rejects = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e as { status: number; code: string },
  );
const active = (orgId: string) =>
  all<{ id: string }>(
    rk.kit.env.DB,
    'SELECT id FROM retention_holds WHERE org_id = ? AND released_at IS NULL',
    [orgId],
  );

describe('legal holds', () => {
  it('an org admin places an org hold; admins are emailed and the audit row holds no free text', async () => {
    const o = await rk.org();
    rk.mail.length = 0;
    const { id } = await placeHold(
      ctx(),
      o.orgId,
      { reason: '  Regulator inquiry 2026, a@b.example  ' },
      orgBy(o),
    );
    const [hold] = await listHolds(ctx(), o.orgId);
    expect(hold).toMatchObject({
      id,
      orgId: o.orgId,
      passId: null,
      placedByKind: 'org',
      placedBy: o.userId,
      reason: 'Regulator inquiry 2026, a@b.example',
      releasedAt: null,
    });
    expect(rk.mail.map((m) => m.to)).toEqual([o.email]);
    expect(rk.mail[0]?.subject).toBe('Legal hold placed');
    const audit = await first<{ detail: string; actor_id: string }>(
      rk.kit.env.DB,
      "SELECT detail, actor_id FROM audit_log WHERE org_id = ? AND action = 'retention.hold.place'",
      [o.orgId],
    );
    expect(audit?.actor_id).toBe(o.userId);
    expect(audit?.detail).not.toMatch(/@|Regulator/);
  });

  it('rejects an empty or oversized reason', async () => {
    const o = await rk.org();
    for (const reason of ['', '   ', 'x'.repeat(501)])
      expect(await rejects(placeHold(ctx(), o.orgId, { reason }, orgBy(o)))).toMatchObject({
        status: 422,
      });
    expect(await active(o.orgId)).toEqual([]);
  });

  it('a pass hold covers that pass only; the pass must belong to the org', async () => {
    const o = await rk.org();
    const pass = await rk.kit.pass({ orgId: o.orgId });
    const other = await rk.kit.pass();
    await placeHold(ctx(), o.orgId, { passId: pass.id, reason: 'dispute' }, orgBy(o));
    expect(await isPassHeld(ctx(), o.orgId, pass.id)).toBe(true);
    expect(await isPassHeld(ctx(), o.orgId, other.id)).toBe(false);
    expect(
      await rejects(placeHold(ctx(), o.orgId, { passId: other.id, reason: 'x' }, orgBy(o))),
    ).toMatchObject({
      status: 404,
    });
  });

  it('an org-wide hold covers every pass of the org and no other org', async () => {
    const [a, b] = [await rk.org(), await rk.org()];
    await placeHold(ctx(), a.orgId, { reason: 'inquiry' }, orgBy(a));
    expect(await isPassHeld(ctx(), a.orgId, 'any-pass')).toBe(true);
    expect(await isPassHeld(ctx(), b.orgId, 'any-pass')).toBe(false);
  });

  it('an org admin releases an org hold once; a released hold stops holding', async () => {
    const o = await rk.org();
    const { id } = await placeHold(ctx(), o.orgId, { reason: 'inquiry' }, orgBy(o));
    await releaseHold(ctx(), o.orgId, id, orgBy(o));
    expect(await active(o.orgId)).toEqual([]);
    expect(await isPassHeld(ctx(), o.orgId, 'p')).toBe(false);
    expect(await rejects(releaseHold(ctx(), o.orgId, id, orgBy(o)))).toMatchObject({ status: 404 });
    const [hold] = await listHolds(ctx(), o.orgId);
    expect(hold).toMatchObject({ releasedBy: o.userId });
  });

  it('an org admin cannot release a platform hold; a platform admin can', async () => {
    const o = await rk.org();
    const admin = await rk.platform();
    const { id } = await placeHold(
      ctx(),
      o.orgId,
      { reason: 'preservation request' },
      { kind: 'platform', admin },
    );
    expect(await rejects(releaseHold(ctx(), o.orgId, id, orgBy(o)))).toMatchObject({
      status: 403,
      code: 'RETENTION_HOLD_PLATFORM',
    });
    expect(await active(o.orgId)).toHaveLength(1);
    // The grant itself refuses it too, even past the service check.
    expect(
      await rejects(
        closeHold(
          ctx(),
          orgBy(o),
          { id, orgId: o.orgId, now: rk.kit.clock.now() },
          { action: 'retention.hold.release', targetId: id, detail: '{}' },
        ),
      ),
    ).not.toBeNull();
    expect(await active(o.orgId)).toHaveLength(1);
    await releaseHold(ctx(), o.orgId, id, { kind: 'platform', admin });
    expect(await active(o.orgId)).toEqual([]);
  });

  it("an org admin cannot touch another org's holds", async () => {
    const [a, b] = [await rk.org(), await rk.org()];
    const { id } = await placeHold(ctx(), b.orgId, { reason: 'inquiry' }, orgBy(b));
    expect(await rejects(placeHold(ctx(), b.orgId, { reason: 'x' }, orgBy(a)))).toMatchObject({
      status: 403,
    });
    expect(await rejects(releaseHold(ctx(), b.orgId, id, orgBy(a)))).toMatchObject({ status: 403 });
    // Naming her own org with the other org's hold id finds nothing.
    expect(await rejects(releaseHold(ctx(), a.orgId, id, orgBy(a)))).toMatchObject({ status: 404 });
    expect(await active(b.orgId)).toHaveLength(1);
    expect(await listHolds(ctx(), a.orgId)).toEqual([]);
  });

  it('refuses a member without org:manage', async () => {
    const o = await rk.org();
    const weak = {
      kind: 'org' as const,
      authority: { ...o.authority, capability: 'org:read' as const },
    };
    expect(await rejects(placeHold(ctx(), o.orgId, { reason: 'x' }, weak))).toMatchObject({
      status: 403,
    });
    expect(await active(o.orgId)).toEqual([]);
  });

  it('a hold row is immutable and cannot be deleted, only released', async () => {
    const o = await rk.org();
    const { id } = await placeHold(ctx(), o.orgId, { reason: 'inquiry' }, orgBy(o));
    const db = rk.kit.env.DB;
    await expect(
      run(db, "UPDATE retention_holds SET reason = 'other' WHERE id = ?", [id]),
    ).rejects.toThrow(/immutable/);
    await expect(
      run(db, "UPDATE retention_holds SET placed_by_kind = 'org' WHERE id = ?", [id]),
    ).resolves.toBeDefined();
    await expect(run(db, 'DELETE FROM retention_holds WHERE id = ?', [id])).rejects.toThrow(
      /release a hold/,
    );
    await releaseHold(ctx(), o.orgId, id, orgBy(o));
    await expect(
      run(db, 'UPDATE retention_holds SET released_at = NULL WHERE id = ?', [id]),
    ).rejects.toThrow(/immutable/);
  });

  it('L5: a platform hold on a suspended org still emails its admins', async () => {
    const o = await rk.org();
    const admin = await rk.platform();
    await run(rk.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [o.orgId]);
    rk.mail.length = 0;
    await placeHold(ctx(), o.orgId, { reason: 'preservation' }, { kind: 'platform', admin });
    expect(rk.mail.map((m) => m.to)).toEqual([o.email]);
  });
});
