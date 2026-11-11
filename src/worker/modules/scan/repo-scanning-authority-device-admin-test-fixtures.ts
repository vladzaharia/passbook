/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureScanTenantAuthority } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { getScanner, scannerEpochsOf } from './repo-device.ts';
import { CHECK_IN, kit, ORIGIN, sessionWithDevice } from './scanning-authority-test-fixtures.ts';
import { joinAdminScanningSession } from './scanning-devices.ts';
import { bindScanningSession, reportScanDevice } from './scanning-workspace.ts';
import { grantScanMembership, proofedScanActor } from './test-kit.ts';

/** Admin actors built by hand carry the epochs the guard would have captured. */
async function captureAdminEpochs(actor: Parameters<typeof captureScanEpochs>[1]) {
  const row = actor.scanner ? await getScanner(kit.env.DB, actor.scanner.id) : null;
  await captureScanEpochs(kit.env.DB, actor, row ? scannerEpochsOf(row) : undefined);
}

export function registerScanningAuthorityDeviceAdmin() {
  it('fences admin device reports to the live platform session and setup owner', async () => {
    const templateId = await kit.scanTemplate('Admin device report', { actions: [CHECK_IN] });
    await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    const { session } = await sessionWithDevice({ templateIds: [templateId] });
    const user = await makeUser(kit.fx);
    let membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
    const _other = await makeUser(kit.fx);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!auth) throw new Error('Missing D1 admin session.');
    const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
    if (authority.kind !== 'session') throw new Error('Expected session authority.');
    const joined = await joinAdminScanningSession(
      kit.ctx,
      user.id,
      'live',
      { sessionId: session.id, deviceKey: crypto.randomUUID() },
      ORIGIN,
      authority,
    );
    const bound = await managedAdminActor(kit.ctx, auth, 'live', kit.org.id, joined.setupId);
    bound.platformSessionId = auth.sessionId;
    bound.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
    await bindScanningSession(kit.ctx, bound);
    const actor = await proofedScanActor(kit.ctx, bound);
    await captureAdminEpochs(actor);
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
    expect(await reportScanDevice(kit.ctx, actor, capabilities)).toMatchObject({
      device: { id: joined.setupId, effectiveSurface: 'phone' },
    });
    const refreshedBound = await managedAdminActor(
      kit.ctx,
      auth,
      'live',
      kit.org.id,
      joined.setupId,
    );
    refreshedBound.platformSessionId = auth.sessionId;
    refreshedBound.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, authority);
    await bindScanningSession(kit.ctx, refreshedBound);
    const refreshed = await proofedScanActor(kit.ctx, refreshedBound);
    await captureAdminEpochs(refreshed);
    const missingAuthority = { ...refreshed };
    delete missingAuthority.tenantAuthority;
    await expect(reportScanDevice(kit.ctx, missingAuthority, capabilities)).rejects.toMatchObject({
      code: 'SCAN_EPOCHS_MISSING',
    });
    // The setup owner is not part of the actor grant (WP5a): revoked sessions and memberships are.
    for (const state of ['revoked', 'membership', 'roles'] as const) {
      if (state === 'revoked')
        await run(kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
          kit.clock.now(),
          auth.sessionId,
        ]);
      if (state === 'membership' || state === 'roles')
        await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          membershipId,
        ]);
      if (state === 'roles')
        membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, [
          'org_admin',
          'read_only',
        ]);
      for (const width of [390, 1200])
        await expect(
          reportScanDevice(kit.ctx, refreshed, { ...capabilities, width }),
        ).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
      await run(kit.env.DB, 'UPDATE sessions SET revoked_at=NULL WHERE id_hash=?', [
        auth.sessionId,
      ]);
      if (state === 'membership')
        membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
      if (state === 'membership' || state === 'roles') {
        const replacement = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
        if (replacement.kind !== 'session') throw new Error('Expected session authority.');
        refreshed.tenantAuthority = await captureScanTenantAuthority(kit.ctx, auth, replacement);
      }
      await run(kit.env.DB, 'UPDATE scanner_setups SET admin_user_id=? WHERE scanner_id=?', [
        user.id,
        joined.setupId,
      ]);
    }
  });
}
