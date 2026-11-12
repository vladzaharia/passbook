/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { scanningSessionRow } from './repo-scanning-sessions.ts';
import { changeMode } from './scanner-mode.ts';
import { updateScanner } from './scanners.ts';
import { CHECK_IN, created, kit } from './scanning-authority-test-fixtures.ts';
import { updateScanningDevice } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { updateScanningSession } from './scanning-sessions.ts';
import { updateSetup } from './setups.ts';
import { grantScanMembership } from './test-kit.ts';

export function registerScanningAuthorityAdminSession() {
  it('refuses every configuration PATCH when its previously resolved admin session is revoked', async () => {
    const templateId = await kit.scanTemplate('Revoked config editor', { actions: [CHECK_IN] });
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Fenced scanner ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const auth = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const sessionId = await sha256Hex(auth.cookieValue);
    const resolved = await createSessionStore(kit.env, kit.clock).resolve(auth.cookieValue);
    if (!resolved) throw new Error('Missing D1 session.');
    const authority = await tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:manage');
    const countAuthority = await captureConsoleSessionCountAuthority(
      kit.ctx,
      resolved,
      await tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:read'),
    );
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at=? WHERE id_hash=?', [
      kit.clock.now(),
      sessionId,
    ]);
    await expect(
      updateScanner(kit.ctx, user.id, scanner.id, { name: 'Rejected scanner' }, authority),
    ).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      updateSetup(kit.ctx, user.id, scanner.id, { name: 'Rejected setup' }, authority),
    ).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      updateScanningDevice(
        kit.ctx,
        user.id,
        scanner.id,
        scanner.id,
        { name: 'Rejected device' },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      updateScanningSession(
        kit.ctx,
        user.id,
        scanner.id,
        { name: 'Rejected session' },
        authority,
        countAuthority,
      ),
    ).rejects.toMatchObject({ code: 'ACTOR_CHANGED' });
    await expect(
      changeMode(kit.ctx, user.id, scanner.id, { mode: 'live' }, authority),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await getConsoleScanner(kit.env.DB, scanner.id))?.name).not.toMatch(/^Rejected/);
    expect((await scanningSessionRow(kit.env.DB, kit.org.id, scanner.id))?.name).not.toBe(
      'Rejected session',
    );
  });
}
