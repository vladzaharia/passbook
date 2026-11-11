import { describe, expect, it } from 'vitest';
import { liveGateFixture } from './live-photo-d1-test-fixtures.ts';
import { liveDisclosureCurrent } from './repo-live-authority.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { kit } from './scan-hub-test-fixtures.ts';

/** Repeated equal sensitive binds deliberately exceed one SELECT without any individual part exceeding D1's limit. */
function largeExtras(value: string) {
  return Array.from({ length: 2 }, () => ({
    sql: Array.from({ length: 48 }, () => '?/* scan-ephemeral-proof */ IS NOT NULL').join(' AND '),
    params: Array.from({ length: 48 }, () => value),
  }));
}

describe('live disclosure bounded D1 batch', () => {
  it('uses one read-only D1 batch above the bind limit without deduplicating equal values', async () => {
    const gate = await liveGateFixture();
    const repeated = `same-secret-${kit.ctx.ids.token()}`;
    const trace = traceLiveD1(kit.env.DB);
    const input = { ...gate.input, extra: () => largeExtras(repeated) };
    expect(await liveDisclosureCurrent(contextWithDb(kit.ctx, trace.db), input, gate.results)).toBe(
      true,
    );
    expect(trace.trips).toHaveLength(1);
    const trip = trace.trips[0]!;
    expect(trip.kind).toBe('batch');
    expect(trip.statements.length).toBeGreaterThan(2);
    expect(
      trip.statements.every(({ sql, params }) => /^\s*SELECT\b/i.test(sql) && params.length < 100),
    ).toBe(true);
    expect(
      trip.statements.reduce((count, statement) => count + statement.params.length, 0),
    ).toBeGreaterThan(99);
    expect(trip.statements.every(({ sql }) => !sql.includes(repeated))).toBe(true);
    expect(
      trip.statements.flatMap(({ params }) => params).filter((value) => value === repeated),
    ).toHaveLength(96);
  });

  it.each(['missing-result', 'empty-row', 'false', 'wrong-type', 'failed'] as const)(
    'requires every fallback SELECT and rejects a %s sentinel',
    async (damage) => {
      const gate = await liveGateFixture();
      const input = { ...gate.input, extra: () => largeExtras('equal-ephemeral-value') };
      const baseline = traceLiveD1(kit.env.DB);
      expect(
        await liveDisclosureCurrent(contextWithDb(kit.ctx, baseline.db), input, gate.results),
      ).toBe(true);
      expect(baseline.trips).toHaveLength(1);
      expect(baseline.trips[0]?.kind).toBe('batch');
      const count = baseline.trips[0]!.statements.length;
      for (let index = 0; index < count; index++) {
        const trace = traceLiveD1(kit.env.DB, (_statements, results) => {
          if (damage === 'missing-result') return results.filter((_, at) => at !== index);
          return results.map((result, at) => {
            if (at !== index) return result;
            if (damage === 'empty-row') return { ...result, results: [] };
            if (damage === 'false') return { ...result, results: [{ current: 0 }] };
            if (damage === 'wrong-type') return { ...result, results: [{ current: '1' }] };
            return { ...result, success: false as const };
          });
        });
        expect(
          await liveDisclosureCurrent(contextWithDb(kit.ctx, trace.db), input, gate.results),
          `${damage} at result ${index}`,
        ).toBe(false);
        expect(trace.trips).toHaveLength(1);
        expect(trace.trips[0]?.kind).toBe('batch');
      }
    },
  );
});
