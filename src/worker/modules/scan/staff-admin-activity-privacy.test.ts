import { describe, expect, it } from 'vitest';
import { makeSession, makeUser, persistTemplate } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { ICON_PNG } from '../passes/pass-test-fixtures.ts';
import { listStaff } from './staff-admin.ts';
import { setupStaffAdminTestKit } from './staff-admin-test-fixtures.ts';
import {
  approveScanReleases,
  grantScanMembership,
  key,
  codeOf as scanCodeOf,
  setupScanKit,
} from './test-kit.ts';

setupStaffAdminTestKit();

describe('mode-specific staff activity and device PIN locks', () => {
  it.each([
    'voided pass',
    'removed pass',
    'soft-deleted pass',
    'voided wallet',
    'expired wallet',
    'malformed wallet',
    'missing wallet',
  ] as const)('retains %s history without exposing its scanner name', async (change) => {
    const kit = await setupScanKit();
    const template = await kit.scanTemplate('Staff retained activity', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in', repeat: 'always' }],
    });
    const person = await kit.staff('manager');
    const scanner = await kit.scanner({
      staffId: person.id,
      templateIds: [template],
      settings: { staffSignIn: true },
    });
    await run(kit.env.DB, "UPDATE scanners SET name = 'Retained entrance' WHERE id = ?", [
      scanner.id,
    ]);
    const pass = await kit.scanPass(template);
    const scanned = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: scanCodeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
    });
    expect(scanned.status).toBe(200);
    expect(await scanned.json()).toMatchObject({ kind: 'ok' });
    const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
    const session = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const initial = await listStaff(kit.ctx, session, authority, kit.org.id, 'live');
    expect(initial.items.find((item) => item.id === person.id)).toMatchObject({
      today: 1,
      lastScan: { at: kit.clock.now(), scannerName: 'Retained entrance' },
    });
    if (change === 'voided pass')
      await run(kit.env.DB, "UPDATE passes SET status = 'voided' WHERE id = ?", [pass.id]);
    else if (change === 'removed pass')
      await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [
        kit.clock.now(),
        pass.id,
      ]);
    else if (change === 'soft-deleted pass')
      await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [
        kit.clock.now(),
        pass.id,
      ]);
    else if (change === 'voided wallet')
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.voided', json('true')) WHERE pass_id = ?",
        [pass.id],
      );
    else if (change === 'expired wallet')
      await run(
        kit.env.DB,
        "UPDATE pass_versions SET pass_json = json_set(pass_json, '$.expirationDate', ?) WHERE pass_id = ?",
        [new Date(kit.clock.now() - 86_400_000).toISOString(), pass.id],
      );
    else if (change === 'malformed wallet')
      await run(kit.env.DB, 'UPDATE pass_versions SET pass_json = ? WHERE pass_id = ?', [
        '{invalid-json',
        pass.id,
      ]);
    else await run(kit.env.DB, 'DELETE FROM pass_versions WHERE pass_id = ?', [pass.id]);
    const retained = await listStaff(kit.ctx, session, authority, kit.org.id, 'live');
    expect(retained.items.find((item) => item.id === person.id)).toMatchObject({
      today: 1,
      lastScan: { at: kit.clock.now(), scannerName: 'Scanner' },
    });
  });

  it('applies the viewer role to a proven scanner name containing a restricted input', async () => {
    const kit = await setupScanKit();
    const template = kit.registry.add({
      id: kit.fx.ids.id(),
      orgId: kit.org.id,
      manifest: {
        ...kit.template.manifest,
        name: 'Staff role privacy',
        inputs: {
          type: 'object',
          required: ['memberName'],
          properties: {
            memberName: { type: 'string' },
            tier: { type: 'string', 'x-scan': 'manager' },
          },
        },
        bindings: [
          ...kit.template.manifest.bindings,
          { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
        ],
        scan: { actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }] },
      },
      passJson: {
        ...kit.template.passJson,
        barcodes: [{ format: 'PKBarcodeFormatQR', message: 'x', messageEncoding: 'iso-8859-1' }],
      },
      assets: { 'icon.png': ICON_PNG },
    });
    await persistTemplate(kit.fx, template, { registry: kit.registry });
    await approveScanReleases(kit, template.id, { orgId: kit.org.id, version: template.version });
    const person = await kit.staff('manager');
    const scanner = await kit.scanner({
      staffId: person.id,
      templateIds: [template.id],
      settings: { staffSignIn: true },
    });
    await run(kit.env.DB, "UPDATE scanners SET name = 'Priority section' WHERE id = ?", [
      scanner.id,
    ]);
    const pass = await kit.scanPass(template.id, { tier: 'Priority section' });
    const result = await kit.post(scanner.headers, '/actions', {
      idempotencyKey: key(),
      input: scanCodeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
    });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ kind: 'ok' });

    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const managerSession = await makeSession(kit.fx, { userId: 'admin-1', roles: ['user'] });
    const readerSession = await makeSession(kit.fx, { userId: reader.id, roles: ['user'] });
    const store = createSessionStore(kit.env, kit.clock);
    const manager = await store.resolve(managerSession.cookieValue);
    const viewer = await store.resolve(readerSession.cookieValue);
    if (!manager || !viewer) throw new Error('Missing sessions');
    const managerAuthority = await tenantAuthorityOf(kit.ctx, manager, kit.org.id, 'scanning:read');
    const viewerAuthority = await tenantAuthorityOf(kit.ctx, viewer, kit.org.id, 'scanning:read');
    if (managerAuthority.kind !== 'session' || viewerAuthority.kind !== 'session')
      throw new Error('Expected session authorities');
    const managed = await listStaff(kit.ctx, manager, managerAuthority, kit.org.id, 'live');
    const restricted = await listStaff(kit.ctx, viewer, viewerAuthority, kit.org.id, 'live');
    expect(managed.items.find((item) => item.id === person.id)?.lastScan?.scannerName).toBe(
      'Priority section',
    );
    expect(restricted.items.find((item) => item.id === person.id)?.lastScan?.scannerName).toBe(
      'Scanner',
    );

    const membership = await first<{ id: string }>(
      kit.env.DB,
      'SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL',
      [kit.org.id, manager.userId],
    );
    if (!membership) throw new Error('Missing manager membership');
    let intercepted = 0;
    const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, prop) {
          if (prop === 'bind') return (...values: unknown[]) => wrap(target.bind(...values));
          const value = Reflect.get(target, prop, target);
          if (prop === 'all')
            return async (...values: unknown[]) => {
              if (!intercepted++) {
                await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                  kit.clock.now(),
                  membership.id,
                ]);
                await grantScanMembership(kit.fx, kit.org.id, manager.userId, ['read_only']);
              }
              return (value as (...args: unknown[]) => Promise<unknown>).apply(target, values);
            };
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      underlying.set(proxy, statement);
      return proxy;
    };
    const db = new Proxy(kit.env.DB, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (statements.some((statement) => underlying.has(statement)) && !intercepted++) {
              await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                kit.clock.now(),
                membership.id,
              ]);
              await grantScanMembership(kit.fx, kit.org.id, manager.userId, ['read_only']);
            }
            return target.batch(
              statements.map((statement) => underlying.get(statement) ?? statement),
            );
          };
        if (prop === 'prepare')
          return (sql: string) =>
            /\bWITH starts AS\b/i.test(sql) ? wrap(target.prepare(sql)) : target.prepare(sql);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const stale = await listStaff(
      { ...kit.ctx, env: { ...kit.env, DB: db } },
      manager,
      managerAuthority,
      kit.org.id,
      'live',
    );
    expect(intercepted).toBe(1);
    expect(stale.items).toEqual([]);
    const downgraded = await tenantAuthorityOf(kit.ctx, manager, kit.org.id, 'scanning:read');
    if (downgraded.kind !== 'session') throw new Error('Expected session authority');
    const current = await listStaff(kit.ctx, manager, downgraded, kit.org.id, 'live');
    expect(current.items.find((item) => item.id === person.id)?.lastScan?.scannerName).toBe(
      'Scanner',
    );
  });
});
