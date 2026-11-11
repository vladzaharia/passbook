import { describe, expect, it, vi } from 'vitest';
import { run } from '../../platform/db.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { assetGrantTokenHash } from './assets.ts';
import { photoAcquisition, traceLiveD1 } from './repo-live-photo-d1-trace-test-fixtures.ts';
import { setSetupWatchStmt } from './repo-setups-test-support.ts';
import { kit, photoFixture } from './scan-hub-test-fixtures.ts';

async function capturedRequest(
  fixture: { pass: { id: string }; monitor: { headers: Record<string, string> }; path: string },
  trace: { db: D1Database },
) {
  const stored = await memberPhoto(kit.env.DB, kit.org.id, fixture.pass.id);
  if (!stored) throw new Error('Missing photo object.');
  const originalDb = kit.env.DB;
  const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
  let opened = 0;
  const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (key, options) => {
    if (key === stored.r2_key) opened++;
    return originalGet(key, options);
  });
  Object.assign(kit.env, { DB: trace.db });
  try {
    return { response: await kit.get(fixture.monitor.headers, fixture.path), opened: () => opened };
  } finally {
    Object.assign(kit.env, { DB: originalDb });
    spy.mockRestore();
  }
}

describe('cold live photo acquisition', () => {
  it('batches the real acquisition and stays within five D1 trips through both stream fences', async () => {
    const fixture = await photoFixture();
    const trace = traceLiveD1(kit.env.DB);
    const { response, opened } = await capturedRequest(fixture, trace);
    expect(response.status).toBe(200);
    expect(opened()).toBe(1);
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.length).toBeGreaterThan(0);
    const index = trace.trips.findIndex(
      (trip) => trip.kind === 'batch' && photoAcquisition(trip.statements),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(trace.trips[index]!.statements).toHaveLength(7);
    expect(
      trace.trips.filter((trip) => trip.kind === 'batch' && photoAcquisition(trip.statements)),
    ).toHaveLength(1);
    expect(trace.trips.length - index).toBeLessThanOrEqual(5);
  });

  it.each(['partial', 'failed'] as const)(
    'fails closed without opening R2 for each %s acquisition result',
    async (damage) => {
      const fixture = await photoFixture();
      for (let index = 0; index < 7; index++) {
        let intercepted = false;
        const trace = traceLiveD1(kit.env.DB, (statements, results) => {
          if (!photoAcquisition(statements)) return results;
          intercepted = true;
          expect(results).toHaveLength(7);
          return damage === 'partial'
            ? results.filter((_, at) => at !== index)
            : results.map((result, at) =>
                at === index ? { ...result, success: false as const } : result,
              );
        });
        const { response, opened } = await capturedRequest(fixture, trace);
        expect(intercepted, `acquisition result ${index}`).toBe(true);
        expect(response.status, `acquisition result ${index}`).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
        expect(opened()).toBe(0);
      }
    },
  );

  it.each([0, 2, 3, 4, 5, 6])(
    'does not treat an empty acquisition result %s as authority',
    async (index) => {
      const fixture = await photoFixture();
      let intercepted = false;
      const trace = traceLiveD1(kit.env.DB, (statements, results) => {
        if (!photoAcquisition(statements)) return results;
        intercepted = true;
        return results.map((result, at) => (at === index ? { ...result, results: [] } : result));
      });
      const { response, opened } = await capturedRequest(fixture, trace);
      expect(intercepted).toBe(true);
      expect(response.status).toBe(404);
      expect(opened()).toBe(0);
    },
  );

  it.each([
    'source-csrf',
    'recipient-csrf',
    'source-token',
    'recipient-token',
    'source-config',
    'recipient-config',
    'source-mode',
    'source-scope',
    'watch',
    'grant',
    'photo',
    'pass',
  ] as const)(
    'fences %s changed immediately after acquisition, before R2 opens',
    async (change) => {
      const fixture = await photoFixture();
      const db = kit.env.DB;
      const grant = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
      const hash = await assetGrantTokenHash(grant ?? undefined);
      if (!hash) throw new Error('Missing photo grant.');
      let raced = false;
      const trace = traceLiveD1(db, async (statements, results) => {
        if (!photoAcquisition(statements) || raced) return results;
        raced = true;
        const source = change.startsWith('source-');
        const scanner = source ? fixture.source.id : fixture.monitor.id;
        if (change.endsWith('-csrf')) {
          await run(db, 'UPDATE scanners SET csrf_secret=?, updated_at=updated_at+1 WHERE id=?', [
            `new-${kit.ctx.ids.token()}`,
            scanner,
          ]);
        } else if (change.endsWith('-token')) {
          await run(db, 'UPDATE scanners SET token_hash=?, updated_at=updated_at+1 WHERE id=?', [
            `${kit.ctx.ids.token()}-new-token-hash`,
            scanner,
          ]);
        } else if (change.endsWith('-config')) {
          // time_zone moves the scanner's config epoch; updated_at is only a timestamp.
          await run(
            db,
            "UPDATE scanners SET time_zone = CASE time_zone WHEN 'UTC' THEN 'Europe/Paris' ELSE 'UTC' END WHERE id=?",
            [scanner],
          );
        } else if (change === 'source-mode') {
          await run(db, "UPDATE scanners SET mode='test', updated_at=updated_at+1 WHERE id=?", [
            scanner,
          ]);
        } else if (change === 'source-scope') {
          await run(db, 'DELETE FROM scanner_templates WHERE scanner_id=? AND template_id=?', [
            scanner,
            fixture.pass.templateId,
          ]);
        } else if (change === 'watch') {
          await setSetupWatchStmt(db, kit.org.id, fixture.monitor.id, {
            scannerIds: [],
            allOrg: false,
          }).run();
        } else if (change === 'grant') {
          await run(db, 'DELETE FROM scan_asset_grant_provenance WHERE token_hash=?', [hash]);
        } else if (change === 'photo') {
          await run(db, 'UPDATE member_photos SET updated_at=updated_at WHERE pass_id=?', [
            fixture.pass.id,
          ]);
        } else {
          await run(db, 'UPDATE passes SET link_generation=link_generation+1 WHERE id=?', [
            fixture.pass.id,
          ]);
        }
        return results;
      });
      const { response, opened } = await capturedRequest(fixture, trace);
      expect(raced).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: 'ASSET_NOT_FOUND' });
      expect(opened()).toBe(0);
    },
  );
});

it('still serves after only a scanner timestamp or name changes', async () => {
  const fixture = await photoFixture();
  await run(
    kit.env.DB,
    "UPDATE scanners SET updated_at=updated_at+1, name=name || ' (renamed)' WHERE id IN (?, ?)",
    [fixture.source.id, fixture.monitor.id],
  );
  expect((await kit.get(fixture.monitor.headers, fixture.path)).status).toBe(200);
});
