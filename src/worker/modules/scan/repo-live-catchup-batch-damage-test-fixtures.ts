import { expect, it } from 'vitest';
import { catchupFixture, isAcquisition, isFinal } from './live-catchup-batch-test-fixtures.ts';
import { liveRowsFor } from './live-render.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { kit } from './scan-hub-test-fixtures.ts';

interface Marker {
  live_row_index: number;
  live_row_kind: number;
  live_row_part: number;
  current: number;
}
function marker(result: D1Result | undefined): Marker | null {
  const row = result?.results?.[0] as Partial<Marker> | undefined;
  return typeof row?.live_row_index === 'number' &&
    typeof row.live_row_kind === 'number' &&
    typeof row.live_row_part === 'number' &&
    typeof row.current === 'number'
    ? (row as Marker)
    : null;
}

export function registerCatchupDamageTests() {
  it('requires every named SELECT result for its row, without sacrificing unrelated rows', async () => {
    const fixture = await catchupFixture();
    let named: { index: number; row: Marker }[] = [];
    const baseline = traceLiveD1(kit.env.DB, (statements, results) => {
      if (isFinal(statements))
        named = results.flatMap((result, index) => {
          const row = marker(result);
          return row ? [{ index, row }] : [];
        });
      return results;
    });
    expect(
      await liveRowsFor(contextWithDb(kit.ctx, baseline.db), fixture.recipient, fixture.rows),
    ).toHaveLength(3);
    expect(new Set(named.map(({ row }) => `${row.live_row_index}:${row.live_row_kind}`))).toEqual(
      new Set(['0:1', '0:2', '1:1', '1:2', '2:2']),
    );
    const firstNamed = named[0];
    if (!firstNamed) throw new Error('Missing named row results.');
    for (const target of named) {
      const targetInput = fixture.inputs[target.row.live_row_index];
      if (!targetInput) throw new Error('Missing input for named row.');
      const damages =
        target.index === firstNamed.index
          ? (['missing', 'failed', 'empty', 'false', 'wrong-type', 'wrong-part'] as const)
          : (['missing', 'failed'] as const);
      for (const damage of damages) {
        let intercepted = false;
        const trace = traceLiveD1(kit.env.DB, (statements, results) => {
          if (!isFinal(statements)) return results;
          intercepted = true;
          const modified = results.map((result, index) => {
            const row = marker(result);
            // Remove the alternate projection so that this test actually exercises the target fence.
            if (
              row?.live_row_index === target.row.live_row_index &&
              row.live_row_kind !== target.row.live_row_kind
            )
              return { ...result, success: false as const };
            if (index !== target.index || damage === 'missing') return result;
            if (damage === 'failed') return { ...result, success: false as const };
            if (damage === 'empty') return { ...result, results: [] };
            return {
              ...result,
              results: [
                {
                  ...row,
                  ...(damage === 'false' ? { current: 0 } : {}),
                  ...(damage === 'wrong-type' ? { current: '1' } : {}),
                  ...(damage === 'wrong-part' ? { live_row_part: 999 } : {}),
                },
              ],
            };
          });
          return damage === 'missing'
            ? modified.filter((_, index) => index !== target.index)
            : modified;
        });
        const output = await liveRowsFor(
          contextWithDb(kit.ctx, trace.db),
          fixture.recipient,
          fixture.rows,
        );
        expect(intercepted, `${damage} ${target.index}`).toBe(true);
        expect(
          output.map((row) => row.id),
          `${damage} ${target.index}`,
        ).toEqual(
          fixture.rows
            .filter((_, index) => index !== target.row.live_row_index)
            .map((row) => row.id),
        );
        expect(JSON.stringify(output)).not.toContain(targetInput.code);
        if (target.row.live_row_index === 1 || damage === 'missing')
          expect(output.every((row) => row.photoUrl === null)).toBe(true);
      }
    }
  }, 120_000);

  it('does not release a photo bearer when any grant result or the transaction receipt is damaged', async () => {
    const fixture = await catchupFixture();
    let grant: number[] = [];
    let receipt = -1;
    const baseline = traceLiveD1(kit.env.DB, (statements, results) => {
      if (isFinal(statements)) {
        const start = statements.findIndex(({ sql }) =>
          sql.includes('INTO scan_asset_grant_provenance'),
        );
        const end = statements.findIndex(
          (statement, index) => index > start && statement.sql.includes('AS live_row_index'),
        );
        if (start < 0 || end <= start) throw new Error('Missing guarded grant statements.');
        grant = Array.from({ length: end - start }, (_, index) => start + index);
        receipt = statements.length - 1;
        const receiptRow = results[receipt]?.results?.[0];
        expect(
          receiptRow && typeof receiptRow === 'object' && 'live_render_final' in receiptRow
            ? receiptRow.live_render_final
            : undefined,
        ).toBe(1);
      }
      return results;
    });
    const valid = await liveRowsFor(
      contextWithDb(kit.ctx, baseline.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(valid[1]?.photoUrl).toBeTruthy();
    expect(grant.length).toBeGreaterThan(3);
    const [firstGrant, secondGrant, thirdGrant] = grant;
    if (firstGrant === undefined || secondGrant === undefined || thirdGrant === undefined)
      throw new Error('Missing guarded grant results.');
    for (const index of [...grant, receipt]) {
      const damages =
        index === grant[0] || index === grant.at(-1) || index === receipt
          ? (['missing', 'failed', 'empty'] as const)
          : (['failed'] as const);
      for (const damage of damages) {
        let intercepted = false;
        const trace = traceLiveD1(kit.env.DB, (statements, results) => {
          if (!isFinal(statements)) return results;
          intercepted = true;
          if (damage === 'missing') return results.filter((_, at) => at !== index);
          return results.map((result, at) =>
            at !== index
              ? result
              : damage === 'failed'
                ? { ...result, success: false as const }
                : { ...result, results: [] },
          );
        });
        const output = await liveRowsFor(
          contextWithDb(kit.ctx, trace.db),
          fixture.recipient,
          fixture.rows,
        );
        expect(intercepted, `${damage} at ${index}`).toBe(true);
        expect(
          output.every((row) => row.photoUrl === null),
          `${damage} at ${index}`,
        ).toBe(true);
        expect(output.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
      }
    }
    for (const [firstIndex, secondIndex] of [
      [firstGrant, secondGrant],
      [secondGrant, thirdGrant],
      [receipt, firstGrant],
    ] as const) {
      const trace = traceLiveD1(kit.env.DB, (statements, results) => {
        if (!isFinal(statements)) return results;
        const changed = [...results];
        const first = changed[firstIndex];
        const second = changed[secondIndex];
        if (!first || !second) throw new Error('Missing grant results to swap.');
        changed[firstIndex] = second;
        changed[secondIndex] = first;
        return changed;
      });
      const output = await liveRowsFor(
        contextWithDb(kit.ctx, trace.db),
        fixture.recipient,
        fixture.rows,
      );
      expect(output.every((row) => row.photoUrl === null)).toBe(true);
    }
  }, 120_000);

  it('accepts reordered tagged read results only for the right original row', async () => {
    const fixture = await catchupFixture();
    const [ordinaryPass, photoPass] = fixture.passes;
    if (!ordinaryPass || !photoPass) throw new Error('Missing catchup passes.');
    let intercepted = false;
    const trace = traceLiveD1(kit.env.DB, (statements, results) => {
      if (!isFinal(statements)) return results;
      const first = results.findIndex((result) => marker(result)?.live_row_index === 0);
      const second = results.findIndex((result) => marker(result)?.live_row_index === 1);
      if (first < 0 || second < 0) throw new Error('Missing tagged row results.');
      intercepted = true;
      const changed = [...results];
      const original = changed[first];
      const replacement = changed[second];
      if (!original || !replacement) throw new Error('Missing tagged row results.');
      changed[first] = replacement;
      changed[second] = original;
      return changed;
    });
    const rows = await liveRowsFor(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(intercepted).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
    expect(rows[0]).toMatchObject({ passId: ordinaryPass.id, holder: 'Catchup Ordinary' });
    expect(rows[1]).toMatchObject({ passId: photoPass.id, holder: 'Catchup Photo' });
    expect(rows[2]).toMatchObject({ passId: null, holder: null, photoUrl: null });
  });

  it('redacts one successfully read but absent candidate under the original source and recipient fences', async () => {
    const fixture = await catchupFixture();
    const [ordinaryPass, photoPass] = fixture.passes;
    if (!ordinaryPass || !photoPass) throw new Error('Missing catchup passes.');
    let intercepted = false;
    const trace = traceLiveD1(kit.env.DB, (statements, results) => {
      if (!isAcquisition(statements)) return results;
      intercepted = true;
      return results.map((result, index) => (index === 4 ? { ...result, results: [] } : result));
    });
    const rows = await liveRowsFor(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(intercepted).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
    expect(rows[0]).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(rows[1]).toMatchObject({ passId: photoPass.id, holder: 'Catchup Photo' });
    const photoRow = rows[1];
    if (!photoRow) throw new Error('Missing photo row.');
    expect(photoRow.photoUrl).toBeTruthy();
    expect(rows[2]).toMatchObject({ passId: null, holder: null, photoUrl: null });
    expect(JSON.stringify(rows[0])).not.toContain(ordinaryPass.id);
  });

  it('fails closed on missing acquisition results and isolates failed source and candidate reads', async () => {
    const fixture = await catchupFixture();
    for (let index = 0; index < 8; index++) {
      for (const damage of ['missing', 'failed'] as const) {
        let intercepted = false;
        const trace = traceLiveD1(kit.env.DB, (statements, results) => {
          if (!isAcquisition(statements)) return results;
          intercepted = true;
          return damage === 'missing'
            ? results.filter((_, at) => at !== index)
            : results.map((result, at) =>
                at === index ? { ...result, success: false as const } : result,
              );
        });
        const rows = await liveRowsFor(
          contextWithDb(kit.ctx, trace.db),
          fixture.recipient,
          fixture.rows,
        );
        expect(intercepted, `${damage} at ${index}`).toBe(true);
        const affected = index < 3 ? -1 : index < 5 ? 0 : index < 7 ? 1 : 2;
        const expected =
          damage === 'missing' || affected < 0
            ? []
            : fixture.rows.filter((_, at) => at !== affected).map((row) => row.id);
        expect(
          rows.map((row) => row.id),
          `${damage} at ${index}`,
        ).toEqual(expected);
        if (damage === 'missing' || affected === 1)
          expect(rows.every((row) => row.photoUrl === null)).toBe(true);
      }
    }
  });
}
