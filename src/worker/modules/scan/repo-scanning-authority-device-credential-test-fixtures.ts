/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { scannerActor } from './actor.ts';
import { getScanner } from './repo-device.ts';
import { scanningDeviceRow } from './repo-scanning-devices.ts';
import { scanningSessionForDevice } from './repo-scanning-sessions.ts';
import { readScannerScope } from './repo-scope.ts';
import { CHECK_IN, kit, sessionWithDevice } from './scanning-authority-test-fixtures.ts';
import { bindScanningSession, reportScanDevice } from './scanning-workspace.ts';
import { proofedScanActor } from './test-kit.ts';

/** A credential change unpairs (401); a configuration change asks for a refetch (409). */
const REFUSED = {
  hash: [401, 'SCANNER_REPAIR'],
  prefix: [401, 'SCANNER_REPAIR'],
  csrf: [401, 'SCANNER_REPAIR'],
  expired: [401, 'SCANNER_REPAIR'],
  expiryChanged: [401, 'SCANNER_REPAIR'],
  idle: [401, 'SCANNER_REPAIR'],
  revoked: [401, 'SCANNER_REPAIR'],
  role: [409, 'SCANNING_DEVICE_CHANGED'],
  kind: [401, 'SCANNER_REPAIR'],
  mode: [401, 'SCANNER_REPAIR'],
  settings: [409, 'SCANNING_DEVICE_CHANGED'],
  sessionSettings: [409, 'SCANNING_DEVICE_CHANGED'],
  accepts: [409, 'SCANNING_DEVICE_CHANGED'],
  overrides: [409, 'SCANNING_DEVICE_CHANGED'],
  org: [403, 'ORG_ACCESS_CHANGED'],
} as const;

export function registerScanningAuthorityDeviceCredential() {
  it('rejects capability reports when the observed scanner credential or configuration changes', async () => {
    const templateId = await kit.scanTemplate('Device report fence', { actions: [CHECK_IN] });
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const { session, device } = await sessionWithDevice({ templateIds: [templateId] }, 'auto');
    const before = await first(
      kit.env.DB,
      `SELECT s.device_role,d.surface,d.effective_surface,d.capabilities,d.reported_at
       FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id WHERE s.id=?`,
      [device.id],
    );
    const capabilities: ScanDeviceCapabilities = {
      width: 390,
      height: 844,
      touch: true,
      camera: 'available',
      keyboard: true,
      nativeBarcode: false,
      surfaces: ['phone', 'operator', 'customer'],
      preferred: 'phone',
    };
    for (const state of Object.keys(REFUSED) as (keyof typeof REFUSED)[]) {
      const scanner = await getScanner(kit.env.DB, device.id);
      const parent = await scanningSessionForDevice(kit.env.DB, kit.org.id, device.id);
      const originalDevice = await scanningDeviceRow(kit.env.DB, kit.org.id, device.id);
      if (!scanner || !parent || !originalDevice) throw new Error('Missing D1 scanner fixture.');
      const scope = await readScannerScope(kit.env.DB, scanner, null);
      const bound = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
      await bindScanningSession(kit.ctx, bound);
      const actor = await proofedScanActor(kit.ctx, bound);
      const now = kit.clock.now();
      if (state === 'hash')
        await run(
          kit.env.DB,
          'UPDATE scanners SET token_hash=?,updated_at=updated_at+1 WHERE id=?',
          [await sha256Hex(kit.fx.ids.token()), device.id],
        );
      if (state === 'prefix')
        await run(
          kit.env.DB,
          'UPDATE scanners SET token_prefix=?,updated_at=updated_at+1 WHERE id=?',
          [kit.fx.ids.token(6), device.id],
        );
      if (state === 'csrf')
        await run(
          kit.env.DB,
          'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?',
          [kit.fx.ids.token(), device.id],
        );
      if (state === 'expired')
        await run(kit.env.DB, 'UPDATE scanners SET expires_at=? WHERE id=?', [now, device.id]);
      if (state === 'expiryChanged')
        await run(kit.env.DB, 'UPDATE scanners SET expires_at=? WHERE id=?', [
          now + 90_000,
          device.id,
        ]);
      if (state === 'idle')
        await run(kit.env.DB, 'UPDATE scanners SET last_seen_at=? WHERE id=?', [
          now - 31 * 86_400_000,
          device.id,
        ]);
      if (state === 'revoked')
        await run(kit.env.DB, 'UPDATE scanners SET revoked_at=? WHERE id=?', [now, device.id]);
      if (state === 'role')
        await run(kit.env.DB, "UPDATE scanners SET device_role='customer' WHERE id=?", [device.id]);
      if (state === 'kind')
        await run(
          kit.env.DB,
          "UPDATE scanners SET kind='display',device_role='customer' WHERE id=?",
          [device.id],
        );
      if (state === 'mode')
        await run(kit.env.DB, "UPDATE scanners SET mode='test' WHERE id=?", [device.id]);
      if (state === 'settings')
        await run(
          kit.env.DB,
          `UPDATE scanners SET settings=json_set(settings,'$.lookup',json('false')) WHERE id=?`,
          [device.id],
        );
      if (state === 'sessionSettings')
        await run(
          kit.env.DB,
          `UPDATE scanning_sessions SET settings=json_set(settings,'$.lookup',json('false')) WHERE id=?`,
          [session.id],
        );
      if (state === 'accepts')
        await run(kit.env.DB, 'UPDATE scanning_sessions SET accepts=NULL WHERE id=?', [session.id]);
      if (state === 'overrides')
        await run(
          kit.env.DB,
          `UPDATE scanning_devices SET overrides=json_set(overrides,'$.flow','choose') WHERE scanner_id=?`,
          [device.id],
        );
      if (state === 'org')
        await run(kit.env.DB, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]);
      const [status, code] = REFUSED[state];
      for (const width of [390, 1200])
        await expect(
          reportScanDevice(kit.ctx, actor, { ...capabilities, width }),
        ).rejects.toMatchObject({ status, code });
      await run(
        kit.env.DB,
        `UPDATE scanners SET token_hash=?,token_prefix=?,csrf_secret=?,expires_at=?,last_seen_at=?,
         revoked_at=?,kind=?,device_role=?,mode=?,settings=?,updated_at=updated_at+1 WHERE id=?`,
        [
          scanner.tokenHash,
          scanner.tokenPrefix,
          scanner.csrfSecret,
          scanner.expiresAt,
          scanner.lastSeenAt,
          scanner.revokedAt,
          scanner.kind,
          scanner.deviceRole,
          scanner.mode,
          scanner.settings,
          device.id,
        ],
      );
      await run(
        kit.env.DB,
        'UPDATE scanning_sessions SET updated_at=?,settings=?,accepts=? WHERE id=?',
        [parent.updated_at, parent.settings, parent.accepts, session.id],
      );
      if (state === 'overrides')
        await run(
          kit.env.DB,
          'UPDATE scanning_devices SET overrides=?,capabilities=? WHERE scanner_id=?',
          [originalDevice.overrides, originalDevice.capabilities, device.id],
        );
      if (state === 'org')
        await run(kit.env.DB, "UPDATE orgs SET status='active' WHERE id=?", [kit.org.id]);
      // Restored values do not revive the old credential: its epoch moved.
      if (state === 'hash' || state === 'prefix' || state === 'csrf')
        await expect(reportScanDevice(kit.ctx, actor, capabilities)).rejects.toMatchObject({
          status: 401,
          code: 'SCANNER_REPAIR',
        });
      expect(
        await first(
          kit.env.DB,
          `SELECT s.device_role,d.surface,d.effective_surface,d.capabilities,d.reported_at
         FROM scanners s JOIN scanning_devices d ON d.scanner_id=s.id WHERE s.id=?`,
          [device.id],
        ),
      ).toEqual(before);
    }
    const restoredScanner = await getScanner(kit.env.DB, device.id);
    if (!restoredScanner) throw new Error('Missing restored scanner.');
    const restoredScope = await readScannerScope(kit.env.DB, restoredScanner, null);
    const restoredBound = scannerActor(
      kit.ctx,
      restoredScanner,
      restoredScanner.mode,
      'cookie',
      restoredScope,
    );
    await bindScanningSession(kit.ctx, restoredBound);
    const restored = await proofedScanActor(kit.ctx, restoredBound);
    // Volatile columns move no epoch: a session timestamp and a capability write do not refuse.
    await run(kit.env.DB, 'UPDATE scanning_sessions SET updated_at=updated_at+1 WHERE id=?', [
      session.id,
    ]);
    await run(kit.env.DB, 'UPDATE scanning_devices SET capabilities=? WHERE scanner_id=?', [
      JSON.stringify(capabilities),
      device.id,
    ]);
    expect(await reportScanDevice(kit.ctx, restored, capabilities)).toMatchObject({
      device: { id: device.id, effectiveSurface: 'phone' },
    });
    const freshScanner = await getScanner(kit.env.DB, device.id);
    if (!freshScanner) throw new Error('Missing refreshed scanner.');
    const freshScope = await readScannerScope(kit.env.DB, freshScanner, null);
    const refreshedBound = scannerActor(
      kit.ctx,
      freshScanner,
      freshScanner.mode,
      'cookie',
      freshScope,
    );
    await bindScanningSession(kit.ctx, refreshedBound);
    const refreshed = await proofedScanActor(kit.ctx, refreshedBound);
    expect(
      await reportScanDevice(kit.ctx, refreshed, { ...capabilities, width: 1200 }),
    ).toMatchObject({
      device: { id: device.id, effectiveSurface: 'operator' },
    });
  });
}
