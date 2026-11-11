import { expect, it } from 'vitest';
import { ManualClock } from '../../platform/clock.ts';
import { first, run } from '../../platform/db.ts';
import {
  catchupFixture,
  catchupPlans,
  isAcquisition,
  isFinal,
} from './live-catchup-batch-test-fixtures.ts';
import { liveRowsFor } from './live-render.ts';
import { finishLiveRows } from './live-render-final.ts';
import { registerCatchupAuthorityRaceTests } from './repo-live-catchup-batch-authority-races-test-fixtures.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { kit } from './scan-hub-test-fixtures.ts';

export function registerCatchupRaceTests() {
  it.each(['pass', 'template'] as const)(
    'redacts only the stale %s after acquisition while other genuine rows survive',
    async (change) => {
      const fixture = await catchupFixture({ separateTemplate: true });
      let raced = false;
      const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
        if (!isAcquisition(statements) || raced) return results;
        raced = true;
        if (change === 'pass')
          await run(kit.env.DB, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [
            fixture.passes[0].id,
          ]);
        else
          await run(kit.env.DB, 'UPDATE templates SET updated_at=updated_at+1 WHERE id=?', [
            fixture.passes[0].templateId,
          ]);
        return results;
      });
      const rows = await liveRowsFor(
        contextWithDb(kit.ctx, trace.db),
        fixture.recipient,
        fixture.rows,
      );
      expect(raced).toBe(true);
      expect(rows.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
      expect(rows[0]).toMatchObject({ passId: null, holder: null, photoUrl: null });
      expect(rows[1]).toMatchObject({ passId: fixture.passes[1].id, holder: 'Catchup Photo' });
      if (!rows[1]) throw new Error('Missing photo row.');
      expect(rows[1].photoUrl).toBeTruthy();
      expect(rows[2]).toMatchObject({
        passId: null,
        holder: null,
        photoUrl: null,
        kind: 'refused',
      });
      expect(JSON.stringify(rows[0])).not.toContain('Catchup Ordinary');
      expect(JSON.stringify(rows[0])).not.toContain(fixture.passes[0].id);
      expect(trace.trips.length).toBeLessThanOrEqual(5);
    },
  );

  it('drops an earlier photo plan that expires while later original rows are prepared', async () => {
    const expiresAt = kit.clock.now() + 60_000;
    const fixture = await catchupFixture({ photoSourceExpiresAt: expiresAt });
    const clock = new ManualClock(kit.clock.now());
    const ctx = { ...kit.ctx, clock };
    const [earlyPhoto] = await catchupPlans(fixture, { indexes: [1], ctx });
    if (!earlyPhoto?.grant) throw new Error('Missing early photo grant plan.');
    expect(earlyPhoto.expiresAt).toBe(expiresAt);
    clock.set(expiresAt + 1);
    const [ordinary, passless] = await catchupPlans(fixture, { indexes: [0, 2], ctx });
    expect(earlyPhoto.grant.plan.expiresAt).toBeGreaterThan(clock.now());
    if (!ordinary || !passless) throw new Error('Missing later row plans.');
    const trace = traceLiveD1(kit.env.DB);
    const rows = await finishLiveRows(contextWithDb(ctx, trace.db), fixture.recipient, [
      earlyPhoto,
      ordinary,
      passless,
    ]);
    expect(rows.map((row) => row.id)).toEqual([fixture.rows[0].id, fixture.rows[2].id]);
    expect(rows[0]).toMatchObject({ passId: fixture.passes[0].id, holder: 'Catchup Ordinary' });
    expect(rows.every((row) => row.photoUrl === null)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(fixture.passes[1].id);
    expect(trace.trips).toHaveLength(1);
    const trip = trace.trips[0];
    if (!trip) throw new Error('Missing final D1 trip.');
    expect(
      trip.statements.every(({ sql }) => !sql.includes('INTO scan_asset_grant_provenance')),
    ).toBe(true);
  });

  it('rolls back a stale photo grant and independently rechecks every row without a bearer', async () => {
    const fixture = await catchupFixture();
    const before = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM scan_asset_grant_provenance',
    );
    let raced = false;
    const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
      if (!isAcquisition(statements) || raced) return results;
      raced = true;
      await run(kit.env.DB, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [
        fixture.passes[1].id,
      ]);
      return results;
    });
    const rows = await liveRowsFor(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(raced).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
    expect(rows[0]).toMatchObject({ passId: fixture.passes[0].id, holder: 'Catchup Ordinary' });
    expect(rows[1]).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(rows[2]).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(rows.every((row) => row.photoUrl === null)).toBe(true);
    expect(
      await first<{ n: number }>(
        kit.env.DB,
        'SELECT COUNT(*) AS n FROM scan_asset_grant_provenance',
      ),
    ).toEqual(before);
    expect(
      trace.trips.filter((trip) => trip.kind === 'batch' && isFinal(trip.statements)),
    ).toHaveLength(2);
    expect(trace.trips.length).toBeLessThanOrEqual(5);
  });

  it.each(['source-revoked', 'source-csrf', 'source-token'] as const)(
    'omits only the row whose original %s changed after acquisition',
    async (change) => {
      const fixture = await catchupFixture();
      let raced = false;
      const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
        if (!isAcquisition(statements) || raced) return results;
        raced = true;
        const id = fixture.sources[0].id;
        if (change === 'source-revoked')
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            id,
          ]);
        else if (change === 'source-csrf')
          await run(
            kit.env.DB,
            'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
            [`new-${kit.ctx.ids.token()}`, id],
          );
        else
          await run(
            kit.env.DB,
            'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
            [`rotated-${kit.ctx.ids.token()}`, id],
          );
        return results;
      });
      const rows = await liveRowsFor(
        contextWithDb(kit.ctx, trace.db),
        fixture.recipient,
        fixture.rows,
      );
      expect(raced).toBe(true);
      expect(rows.map((row) => row.id)).toEqual(fixture.rows.slice(1).map((row) => row.id));
      expect(rows[0]).toMatchObject({ passId: fixture.passes[1].id, holder: 'Catchup Photo' });
      if (!rows[0]) throw new Error('Missing photo row.');
      expect(rows[0].photoUrl).toBeTruthy();
      expect(JSON.stringify(rows)).not.toContain(fixture.passes[0].id);
      expect(JSON.stringify(rows)).not.toContain('Catchup Ordinary');
      expect(trace.trips.length).toBeLessThanOrEqual(5);
    },
  );

  it.each(['revoked', 'csrf'] as const)(
    'rolls back the photo grant when its original source is %s while preserving other rows',
    async (change) => {
      const fixture = await catchupFixture();
      let raced = false;
      const trace = traceLiveD1(kit.env.DB, async (statements, results) => {
        if (!isAcquisition(statements) || raced) return results;
        raced = true;
        if (change === 'revoked')
          await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
            kit.clock.now(),
            fixture.sources[1].id,
          ]);
        else
          await run(
            kit.env.DB,
            'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
            [`changed-${kit.ctx.ids.token()}`, fixture.sources[1].id],
          );
        return results;
      });
      const rows = await liveRowsFor(
        contextWithDb(kit.ctx, trace.db),
        fixture.recipient,
        fixture.rows,
      );
      expect(raced).toBe(true);
      expect(rows.map((row) => row.id)).toEqual([fixture.rows[0].id, fixture.rows[2].id]);
      expect(rows[0]).toMatchObject({ passId: fixture.passes[0].id, holder: 'Catchup Ordinary' });
      expect(rows.every((row) => row.photoUrl === null)).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(fixture.passes[1].id);
      expect(trace.trips.length).toBeLessThanOrEqual(5);
    },
  );

  registerCatchupAuthorityRaceTests();
}
