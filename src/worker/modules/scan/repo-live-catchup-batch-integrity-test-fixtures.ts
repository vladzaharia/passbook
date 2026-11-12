import { expect, it } from 'vitest';
import { liveRecipient } from './live-auth.ts';
import {
  catchupFixture,
  catchupPlans,
  isAcquisition,
  isFinal,
} from './live-catchup-batch-test-fixtures.ts';
import { liveRowsFor } from './live-render.ts';
import { finishLiveRows } from './live-render-final.ts';
import { contextWithDb, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { scanSecretSlots } from './repo-secret-binds.ts';
import { hub, kit } from './scan-hub-test-fixtures.ts';

export function registerCatchupIntegrityTests() {
  it('catches up genuine ordinary, photo and passless events in order within the post-guard D1 budget', async () => {
    const fixture = await catchupFixture();
    const [ordinaryPass, photoPass] = fixture.passes;
    const [ordinaryRow, photoRow, refusedRow] = fixture.rows;
    if (!ordinaryPass || !photoPass || !ordinaryRow || !photoRow || !refusedRow)
      throw new Error('Missing catchup passes or rows.');
    const trace = traceLiveD1(kit.env.DB);
    const ctx = contextWithDb(kit.ctx, trace.db);
    const recipient = await liveRecipient(ctx, fixture.monitor.attachment);
    if (!recipient) throw new Error('Recipient unexpectedly rejected.');
    const rendered = await liveRowsFor(ctx, recipient, fixture.rows);
    expect(rendered.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
    expect(rendered).toMatchObject([
      { passId: ordinaryPass.id, holder: 'Catchup Ordinary', photoUrl: null },
      { passId: photoPass.id, holder: 'Catchup Photo' },
      { passId: null, holder: null, photoUrl: null, kind: 'refused' },
    ]);
    const renderedPhoto = rendered[1];
    if (!renderedPhoto) throw new Error('Missing photo row.');
    const photo = renderedPhoto.photoUrl;
    if (!photo) throw new Error('Missing photo grant.');
    const url = new URL(photo, 'https://wallet.test');
    expect(url.searchParams.get('event')).toBe(photoRow.id);
    expect(url.searchParams.get('g')).toBeTruthy();
    const response = await kit.get(fixture.monitor.headers, photo.replace('/api/v1/scan', ''));
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const snapshot = await hub().snapshot(fixture.monitor.attachment, ordinaryRow.id);
    expect(snapshot.rows.map((row) => row.id)).toEqual(fixture.rows.slice(1).map((row) => row.id));
    expect(snapshot.cursor).toBe(refusedRow.id);
    const serialized = JSON.stringify(rendered);
    for (const row of rendered) expect(row).not.toHaveProperty('sourceProof');
    for (const secret of [
      ...fixture.sources.map((source) => source.token),
      ...fixture.inputs.map((input) => input.code),
      ...fixture.rows.map((row) => row.sourceProof),
    ])
      expect(serialized).not.toContain(secret);
    expect(trace.trips.length).toBeLessThanOrEqual(5);
    const acquisitions = trace.trips.filter(
      (trip) => trip.kind === 'batch' && isAcquisition(trip.statements),
    );
    const finals = trace.trips.filter((trip) => trip.kind === 'batch' && isFinal(trip.statements));
    expect(acquisitions).toHaveLength(1);
    expect(finals).toHaveLength(1);
    const acquisition = acquisitions[0];
    const final = finals[0];
    if (!acquisition || !final) throw new Error('Missing acquisition or final batch.');
    expect(acquisition.statements).toHaveLength(8); // watch, stamps, recipient, 3 sources, 2 passes
    expect(
      acquisition.statements.filter(({ sql }) => sql.includes('AS scanner_secret')),
    ).toHaveLength(4);
    expect(
      acquisition.statements.filter(({ sql }) => sql.includes('AS live_template_snapshot')),
    ).toHaveLength(2);
    const finalSql = final.statements.map(({ sql }) => sql).join('\n');
    for (const part of [
      'FROM scanner_setups m',
      'pass_credential_tombstones',
      'scan-ephemeral-template-snapshot',
      'scan-ephemeral-csrf:source:scanner',
      'scan-ephemeral-csrf:recipient:scanner',
      'asset_grant_step',
      'asset_grant_final',
      'AS live_row_index',
    ])
      expect(finalSql).toContain(part);
    expect(
      final.statements.some(({ sql }) => sql.includes('INTO scan_asset_grant_provenance')),
    ).toBe(true);
    expect(final.statements.at(-1)?.sql).toContain('live_render_final');
    expect(
      final.statements.reduce((n, statement) => n + statement.params.length, 0),
    ).toBeGreaterThan(99);
    expect(
      trace.trips.flatMap((trip) => trip.statements).every(({ params }) => params.length < 100),
    ).toBe(true);
  });

  it('retains each original source actor, credential and repeated recipient secret as separate scalar binds', async () => {
    const fixture = await catchupFixture();
    let seen: { sql: string; params: unknown[]; row: number; kind: number }[] = [];
    const trace = traceLiveD1(kit.env.DB, (statements, results) => {
      if (isFinal(statements))
        seen = statements.flatMap((statement, index) => {
          const item = results[index]?.results?.[0] as
            | { live_row_index?: unknown; live_row_kind?: unknown }
            | undefined;
          return typeof item?.live_row_index === 'number' && typeof item.live_row_kind === 'number'
            ? [{ ...statement, row: item.live_row_index, kind: item.live_row_kind }]
            : [];
        });
      return results;
    });
    const rendered = await liveRowsFor(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      fixture.rows,
    );
    expect(rendered.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
    expect(new Set(fixture.sources.map((source) => source.token)).size).toBe(3);
    expect(
      new Set(
        fixture.proofs.map((proof) =>
          JSON.stringify(proof.credentialContext.credentialTombstoneRefs),
        ),
      ).size,
    ).toBe(3);
    for (const [index, source] of fixture.sources.entries()) {
      const statements = seen.filter(
        (entry) => entry.row === index && entry.kind === (index === 2 ? 2 : 1),
      );
      expect(statements.length).toBeGreaterThan(0);
      const values = statements.flatMap((entry) => entry.params);
      const csrf = source.headers['x-csrf-token'];
      const recipientCsrf = fixture.monitor.headers['x-csrf-token'];
      const proof = fixture.proofs[index];
      const scanner = proof?.actor.scanner;
      if (!proof || !scanner) throw new Error('Missing source scanner proof.');
      const refs = JSON.stringify(proof.credentialContext.credentialTombstoneRefs);
      if (csrf === undefined || recipientCsrf === undefined || refs === undefined)
        throw new Error('Missing source or recipient authority.');
      expect(values).toContain(source.id);
      expect(values).toContain(scanner.tokenHash);
      expect(values).toContain(csrf);
      expect(values).toContain(recipientCsrf);
      expect(values).toContain(refs);
      for (const secret of [csrf, recipientCsrf, refs]) {
        expect(statements.every(({ sql }) => !sql.includes(secret))).toBe(true);
        expect(
          values.some(
            (value) => typeof value === 'string' && value !== secret && value.includes(secret),
          ),
        ).toBe(false);
      }
    }
  });

  it('splits a greater-than-99-bind row fence into real D1 SELECTs without deduplicating equal scalar values', async () => {
    const fixture = await catchupFixture();
    const [ordinaryRow, , refusedRow] = fixture.rows;
    const ordinaryPass = fixture.passes[0];
    const source = fixture.sources[0];
    if (!ordinaryRow || !refusedRow || !ordinaryPass || !source)
      throw new Error('Missing catchup rows, pass or source.');
    const plans = await catchupPlans(fixture);
    const secret = source.id;
    const extra = Array.from({ length: 2 }, () => ({
      sql: Array.from(
        { length: 24 },
        () => `EXISTS (SELECT 1 FROM scanners split_source
        WHERE split_source.id=?/* scan-ephemeral-proof */ AND split_source.id=?/* scan-ephemeral-proof */
          AND split_source.org_id=scope.org_id AND split_source.mode=scope.mode AND split_source.revoked_at IS NULL)`,
      ).join(' AND '),
      params: Array.from({ length: 48 }, () => secret),
    }));
    const first = plans[0];
    const third = plans[2];
    if (!first || !third) throw new Error('Missing catchup plans.');
    if (!first.visibleFences) throw new Error('Missing visible fence.');
    const firstPlan = { ...first, visibleFences: [...first.visibleFences, ...extra] };
    plans[0] = firstPlan;
    // Exercise the split read-only path with two genuine rows and no photo grant to remint.
    const readPlans = [firstPlan, third];
    let parts: { part: number; index: number }[] = [];
    const trace = traceLiveD1(kit.env.DB, (statements, results) => {
      if (isFinal(statements))
        parts = results.flatMap((result, index) => {
          const row = result.results?.[0] as
            | { live_row_index?: number; live_row_kind?: number; live_row_part?: number }
            | undefined;
          return row?.live_row_index === 0 &&
            row.live_row_kind === 1 &&
            typeof row.live_row_part === 'number'
            ? [{ part: row.live_row_part, index }]
            : [];
        });
      return results;
    });
    const rows = await finishLiveRows(
      contextWithDb(kit.ctx, trace.db),
      fixture.recipient,
      readPlans,
    );
    expect(rows.map((row) => row.id)).toEqual([ordinaryRow.id, refusedRow.id]);
    expect(rows[0]).toMatchObject({ passId: ordinaryPass.id, holder: 'Catchup Ordinary' });
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map(({ part }) => part)).toEqual(parts.map((_, index) => index));
    expect(trace.trips).toHaveLength(1);
    const trip = trace.trips[0];
    if (!trip) throw new Error('Missing split read trip.');
    const statements = trip.statements;
    expect(statements.every(({ params }) => params.length < 100)).toBe(true);
    const proofBinds = statements.flatMap(({ sql, params }) =>
      (scanSecretSlots(sql, params.length) ?? []).flatMap((slot, index) =>
        slot.label === 'proof' ? [params[index]] : [],
      ),
    );
    expect(proofBinds).toHaveLength(96);
    expect(proofBinds.every((value) => value === secret)).toBe(true);
    expect(statements.every(({ sql }) => !sql.includes(secret))).toBe(true);
    for (const { index } of parts) {
      for (const damage of ['missing', 'failed', 'duplicate'] as const) {
        const broken = traceLiveD1(kit.env.DB, (batch, results) => {
          if (!isFinal(batch)) return results;
          const duplicate = parts.find((part) => part.index !== index);
          if (!duplicate) throw new Error('Missing second split part.');
          const modified = results.map((result, at) => {
            const row = result.results?.[0] as
              | { live_row_index?: number; live_row_kind?: number }
              | undefined;
            if (
              (row?.live_row_index === 0 && row.live_row_kind === 2) ||
              (at === index && damage === 'failed')
            )
              return { ...result, success: false as const };
            if (at === index && damage === 'duplicate') {
              const duplicateResult = results[duplicate.index];
              if (!duplicateResult) throw new Error('Missing second split result.');
              return duplicateResult;
            }
            return result;
          });
          return damage === 'missing' ? modified.filter((_, at) => at !== index) : modified;
        });
        const projected = await finishLiveRows(
          contextWithDb(kit.ctx, broken.db),
          fixture.recipient,
          readPlans,
        );
        expect(
          projected.map((row) => row.id),
          `${damage} split result ${index}`,
        ).toEqual([refusedRow.id]);
        expect(projected.every((row) => row.photoUrl === null)).toBe(true);
      }
    }
  }, 120_000);
}
