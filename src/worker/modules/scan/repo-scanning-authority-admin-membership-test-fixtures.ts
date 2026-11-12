/* istanbul ignore file -- @preserve */
import { expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreateScannerSetupSchema } from '../../../shared/contracts/scan-setups.ts';
import { CreateScannerSchema } from '../../../shared/contracts/scanners.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getConsoleScanner } from './repo-scanners.ts';
import { changeMode } from './scanner-mode.ts';
import { createScanner } from './scanners.ts';
import {
  adminUserId,
  CHECK_IN,
  created,
  kit,
  ORIGIN,
  request,
} from './scanning-authority-test-fixtures.ts';
import { createScanningDevice, revokeScanner } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { createSetup } from './setups.ts';
import { grantScanMembership } from './test-kit.ts';

export function registerScanningAuthorityAdminMembership() {
  it('fences create, mode and revoke operations to the captured membership', async () => {
    const templateId = await kit.scanTemplate('Creation fence', { actions: [CHECK_IN] });
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Mode fence ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    const original = await getConsoleScanner(kit.env.DB, scanner.id);
    if (!original) throw new Error('Missing scanner fixture.');
    for (const state of ['revoked', 'regranted', 'roles'] as const) {
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
      const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
      if (!auth) throw new Error('Missing D1 session.');
      const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
      const countAuthority = await captureConsoleSessionCountAuthority(
        kit.ctx,
        auth,
        await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
      );
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        membershipId,
      ]);
      if (state === 'regranted') await grantScanMembership(kit.fx, kit.org.id, user.id);
      if (state === 'roles')
        await grantScanMembership(kit.fx, kit.org.id, user.id, ['org_admin', 'read_only']);
      const suffix = kit.fx.ids.token(5);
      const name = `Rejected ${suffix}`;
      await expect(
        createScanner(
          kit.ctx,
          user.id,
          'live',
          CreateScannerSchema.parse({
            orgId: kit.org.id,
            name,
            kind: 'terminal',
            accepts: { templateIds: [templateId] },
            timeZone: 'UTC',
          }),
          ORIGIN,
          authority,
        ),
      ).rejects.toThrow();
      await expect(
        createSetup(
          kit.ctx,
          user.id,
          'live',
          CreateScannerSetupSchema.parse({
            orgId: kit.org.id,
            name,
            timeZone: 'UTC',
          }),
          ORIGIN,
          authority,
        ),
      ).rejects.toThrow();
      await expect(
        createScanningSession(
          kit.ctx,
          user.id,
          'live',
          CreateScanningSessionSchema.parse({
            orgId: kit.org.id,
            name,
            timeZone: 'UTC',
          }),
          authority,
          countAuthority,
        ),
      ).rejects.toThrow();
      await expect(
        createScanningDevice(
          kit.ctx,
          user.id,
          'live',
          scanner.id,
          { name, surface: 'phone', overrides: {} },
          ORIGIN,
          authority,
        ),
      ).rejects.toThrow();
      await expect(
        changeMode(kit.ctx, user.id, scanner.id, { mode: 'test' }, authority),
      ).rejects.toThrow();
      await expect(revokeScanner(kit.ctx, user.id, scanner.id, authority)).rejects.toThrow();
      expect(
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT (SELECT count(*) FROM scanners WHERE name=?) + (SELECT count(*) FROM scanning_sessions WHERE name=?) AS n',
          [name, name],
        ),
      ).toEqual({ n: 0 });
    }
    expect(await getConsoleScanner(kit.env.DB, scanner.id)).toMatchObject({
      mode: original.mode,
      revokedAt: null,
      name: original.name,
    });
  });

  it('requires explicit tenant membership on configuration reads and writes', async () => {
    const templateId = await kit.scanTemplate('Tenant configuration access', {
      actions: [CHECK_IN],
    });
    const scanner = await created('/scanners', {
      orgId: kit.org.id,
      name: `Access fence ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [templateId] },
      timeZone: 'UTC',
    });
    const outsider = await makeUser(kit.fx);
    const platform = await makeSession(kit.fx, { userId: outsider.id, roles: ['admin', 'user'] });
    expect(
      (await request('GET', `/scanners/${scanner.id}`, undefined, platform.headers)).status,
    ).toBe(403);
    expect(
      (await request('GET', `/scan-setups/${scanner.id}`, undefined, platform.headers)).status,
    ).toBe(403);
    expect(
      (await request('GET', `/scanning-sessions/${scanner.id}`, undefined, platform.headers))
        .status,
    ).toBe(403);
    expect(
      (
        await request(
          'POST',
          '/scanning-sessions',
          {
            orgId: kit.org.id,
            name: 'No membership',
            timeZone: 'UTC',
          },
          platform.headers,
        )
      ).status,
    ).toBe(403);
    const empty = await request('GET', '/scanners?limit=1', undefined, platform.headers);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ items: [], nextCursor: null });

    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const readerSession = await makeSession(kit.fx, { userId: reader.id, roles: ['user'] });
    const otherOrg = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, otherOrg.id, adminUserId);
    const foreignTemplate = await kit.scanTemplate(
      'Foreign configuration',
      { actions: [CHECK_IN] },
      { orgId: otherOrg.id },
    );
    const foreign = await created('/scanners', {
      orgId: otherOrg.id,
      name: `Foreign ${kit.fx.ids.token(5)}`,
      kind: 'device',
      accepts: { templateIds: [foreignTemplate] },
      timeZone: 'UTC',
    });
    for (const path of [
      `/scanners/${scanner.id}`,
      `/scan-setups/${scanner.id}`,
      `/scanning-sessions/${scanner.id}`,
      `/scanners?orgId=${kit.org.id}`,
      `/scan-setups?orgId=${kit.org.id}`,
      `/scanning-sessions?orgId=${kit.org.id}`,
    ])
      expect((await request('GET', path, undefined, readerSession.headers)).status).toBe(200);
    for (const path of ['/scanners', '/scan-setups', '/scanning-sessions']) {
      expect(
        (await request('GET', `${path}?orgId=${otherOrg.id}`, undefined, readerSession.headers))
          .status,
      ).toBe(403);
      const response = await request('GET', `${path}?limit=100`, undefined, readerSession.headers);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: { id: string; orgId: string }[] };
      expect(page.items.every((item) => item.orgId === kit.org.id)).toBe(true);
      expect(page.items.some((item) => item.id === foreign.id)).toBe(false);
    }
    await grantScanMembership(kit.fx, otherOrg.id, reader.id, ['read_only']);
    const both = await request('GET', '/scanners?limit=200', undefined, readerSession.headers);
    const bothPage = (await both.json()) as { items: { id: string }[] };
    expect(bothPage.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([scanner.id, foreign.id]),
    );
    const firstPage = (await (
      await request('GET', '/scanners?limit=1', undefined, readerSession.headers)
    ).json()) as { items: { id: string }[]; nextCursor: string | null };
    expect(firstPage.nextCursor).toBe(firstPage.items[0]?.id);
    const secondPage = (await (
      await request(
        'GET',
        `/scanners?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
        undefined,
        readerSession.headers,
      )
    ).json()) as { items: { id: string }[] };
    expect(secondPage.items).toHaveLength(1);
    expect((secondPage.items[0]?.id ?? '') < (firstPage.items[0]?.id ?? '')).toBe(true);
    expect(
      (
        await request(
          'PATCH',
          `/scanners/${scanner.id}`,
          { name: 'Reader write' },
          readerSession.headers,
        )
      ).status,
    ).toBe(403);

    const manager = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, manager.id);
    const managerSession = await makeSession(kit.fx, { userId: manager.id, roles: ['user'] });
    const made = await request(
      'POST',
      '/scanning-sessions',
      {
        orgId: kit.org.id,
        name: `Tenant user ${kit.fx.ids.token(5)}`,
        timeZone: 'UTC',
      },
      managerSession.headers,
    );
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    expect(
      (
        await request(
          'PATCH',
          `/scanning-sessions/${id}`,
          { name: 'Tenant user edited' },
          managerSession.headers,
        )
      ).status,
    ).toBe(200);
  });
}
