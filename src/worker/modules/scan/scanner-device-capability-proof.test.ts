import { describe, expect, it } from 'vitest';
import { SCANNER_COOKIE } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { AppError } from '../../platform/errors.ts';
import { getScanner } from './repo-device.ts';
import {
  capabilities,
  deviceState,
  fixture,
  intercept,
  kit,
  ORIGIN,
  pairedActor,
  registerScannerCapabilityFixture,
} from './repo-scanner-device-capability-proof-test-fixtures.ts';
import { reportScanDevice } from './scanning-workspace.ts';

registerScannerCapabilityFixture();

describe('scanner capability actor proof', () => {
  it('accepts redacted paired actors for both capability-only and surface-changing reports', async () => {
    const f = await fixture();
    const firstActor = await pairedActor(f.device.id);
    expect(firstActor.scanner?.csrfSecret).toBeNull();
    expect(JSON.stringify(firstActor)).not.toContain(f.secret);
    const captured = intercept(kit.env.DB);
    const ctx = { ...kit.ctx, env: { ...kit.env, DB: captured.db } };
    expect(await reportScanDevice(ctx, firstActor, capabilities(390))).toMatchObject({
      device: { id: f.device.id, effectiveSurface: 'phone' },
    });
    const refreshed = await pairedActor(f.device.id);
    expect(await reportScanDevice(ctx, refreshed, capabilities(1200))).toMatchObject({
      device: { id: f.device.id, effectiveSurface: 'operator' },
    });
    // CSRF is verified once by the guard; its secret never reaches the report's SQL.
    expect(captured.writes.length).toBeGreaterThan(0);
    expect(JSON.stringify(captured.writes)).not.toContain(f.secret);
    expect(
      await first(
        kit.env.DB,
        'SELECT effective_surface,capabilities FROM scanning_devices WHERE scanner_id=?',
        [f.device.id],
      ),
    ).toMatchObject({
      effective_surface: 'operator',
      capabilities: expect.stringContaining('1200'),
    });
  });

  it('accepts a paired cookie through the real guard without exposing its CSRF secret', async () => {
    const f = await fixture();
    const response = await kit.post(
      {
        cookie: `${SCANNER_COOKIE}=${f.token}`,
        'x-csrf-token': f.secret,
        origin: ORIGIN,
        'sec-fetch-site': 'same-origin',
      },
      '/device',
      { capabilities: capabilities(390) },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain(f.secret);
    expect(JSON.parse(body)).toMatchObject({
      device: { id: f.device.id, effectiveSurface: 'phone' },
    });
  });

  it.each([390, 1200])(
    'refuses a rotated or revoked credential atomically, but not a session revision, at width %i',
    async (width) => {
      for (const change of ['csrf', 'token', 'prefix', 'revoked', 'aba', 'session'] as const) {
        const f = await fixture();
        const actor = await pairedActor(f.device.id);
        const original = await getScanner(kit.env.DB, f.device.id);
        if (!original) throw new Error('Missing original scanner.');
        const before = await deviceState(f.device.id);
        const raced = intercept(kit.env.DB, async () => {
          if (change === 'csrf')
            await run(
              kit.env.DB,
              'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
              ['rotated-secret', f.device.id],
            );
          if (change === 'token' || change === 'aba')
            await run(
              kit.env.DB,
              'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
              ['rotated-hash', f.device.id],
            );
          if (change === 'aba')
            await run(
              kit.env.DB,
              'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
              [original.tokenHash, f.device.id],
            );
          if (change === 'prefix')
            await run(
              kit.env.DB,
              'UPDATE scanners SET token_prefix=?,updated_at=updated_at+1 WHERE id=?',
              [kit.fx.ids.token(8), f.device.id],
            );
          if (change === 'revoked')
            await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [
              kit.clock.now(),
              f.device.id,
            ]);
          if (change === 'session')
            await run(
              kit.env.DB,
              'UPDATE scanning_sessions SET updated_at=updated_at+1 WHERE id=?',
              [f.session.id],
            );
        });
        const ctx = { ...kit.ctx, env: { ...kit.env, DB: raced.db } };
        if (change === 'session') {
          // A revision is a timestamp: the report goes through.
          await expect(reportScanDevice(ctx, actor, capabilities(width))).resolves.toBeTruthy();
        } else {
          // The credential epoch moved: the device must pair again, and nothing was written.
          await expect(reportScanDevice(ctx, actor, capabilities(width))).rejects.toMatchObject({
            code: 'SCANNER_REPAIR',
          });
          expect(await deviceState(f.device.id)).toEqual(before);
        }
        expect(raced.fired()).toBe(true);
      }
    },
  );

  it('refuses an actor whose workspace or identity is not the one the guard captured', async () => {
    for (const change of ['scanner', 'session'] as const) {
      const f = await fixture();
      const actor = await pairedActor(f.device.id);
      if (!actor.scanner || !actor.scanningSession) throw new Error('Missing actor binding.');
      if (change === 'scanner') actor.scanner.id = 'another-scanner';
      if (change === 'session') actor.scanningSession.id = 'other-session';
      const before = await deviceState(f.device.id);
      for (const width of [390, 1200])
        await expect(reportScanDevice(kit.ctx, actor, capabilities(width))).rejects.toBeInstanceOf(
          AppError,
        );
      expect(await deviceState(f.device.id)).toEqual(before);
    }
  });
});
