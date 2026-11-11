import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, type ScanActor, tenantScanRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { canShowMemberPhoto } from './member-photo.ts';
import {
  expectNoUndo,
  kit,
  raceBatch,
  scenario,
  templateId,
} from './repo-undo-authority-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';
import { consoleUndo, undo } from './undo.ts';

describe('undo replay and console authority', () => {
  it('uses a pass operator tenant membership for console undo without a platform admin role', async () => {
    const s = await scenario();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing administrator session');
    const result = await consoleUndo(kit.ctx, session, {
      scanId: s.targetId,
      orgId: kit.org.id,
      mode: 'live',
      idempotencyKey: key(),
      maxAgeMs: 86_400_000,
    });
    expect(result).toMatchObject({ kind: 'ok', replay: false });
  });

  it('does not replay a console undo with a revoked administrator session', async () => {
    const s = await scenario();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing administrator session');
    const input = {
      scanId: s.targetId,
      orgId: kit.org.id,
      mode: 'live' as const,
      idempotencyKey: key(),
      maxAgeMs: 86_400_000,
    };
    await consoleUndo(kit.ctx, session, input);
    await run(kit.env.DB, 'UPDATE sessions SET revoked_at=1 WHERE id_hash=?', [session.sessionId]);
    await expect(consoleUndo(kit.ctx, session, input)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('rejects a console undo if its administrator session is revoked before commit', async () => {
    const s = await scenario();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing administrator session');
    const undoKey = key();
    const race = raceBatch('UPDATE scan_gates SET state', (db) =>
      run(db, 'UPDATE sessions SET revoked_at=1 WHERE id_hash=?', [session.sessionId]),
    );
    await expect(
      consoleUndo(race.ctx, session, {
        scanId: s.targetId,
        orgId: kit.org.id,
        mode: 'live',
        idempotencyKey: undoKey,
        maxAgeMs: 86_400_000,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(race.raced()).toBe(true);
    expect(await first(kit.env.DB, 'SELECT undone_by FROM scans WHERE id=?', [s.targetId])).toEqual(
      { undone_by: null },
    );
    expect(
      await first(kit.env.DB, "SELECT id FROM pass_events WHERE pass_id=? AND kind='scan.undone'", [
        s.pass.id,
      ]),
    ).toBeNull();
  });

  it('denies console undo without an operating membership, including platform admins', async () => {
    const s = await scenario();
    const user = await makeUser(kit.fx);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const undoKey = key();
    const input = {
      scanId: s.targetId,
      orgId: kit.org.id,
      mode: 'live' as const,
      idempotencyKey: undoKey,
      maxAgeMs: 86_400_000,
    };
    await expect(consoleUndo(kit.ctx, session, input)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['read_only']);
    await expect(consoleUndo(kit.ctx, session, input)).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
    });
    await expectNoUndo(s, undoKey);
    expect(
      await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [undoKey]),
    ).toBeNull();
  });

  it.each(['read_only', 'org_admin'] as const)(
    'does not let a %s read snapshot authorize undo',
    async (role) => {
      const s = await scenario();
      const user = await makeUser(kit.fx);
      await grantScanMembership(kit.fx, kit.org.id, user.id, [role]);
      const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
      if (!session) throw new Error('Missing session');
      const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
      if (authority.kind !== 'session') throw new Error('Expected session authority');
      const actor: ScanActor = {
        ...adminActor(session, 'live', {
          orgId: kit.org.id,
          event: null,
          templateIds: [],
          timeZone: 'UTC',
        }),
        role: tenantScanRole(authority),
        platformSessionId: session.sessionId,
        tenantAuthority: await captureScanTenantAuthority(kit.ctx, session, authority),
      };
      await captureScanEpochs(kit.env.DB, actor);
      const undoKey = key();
      await expect(
        undo(kit.ctx, actor, s.targetId, { idempotencyKey: undoKey }),
      ).rejects.toMatchObject({ status: 403, code: 'SCAN_UNDO_FORBIDDEN' });
      await expectNoUndo(s, undoKey);
      expect(
        await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [undoKey]),
      ).toBeNull();
    },
  );

  it.each(['revoked', 'downgraded', 'same-role ABA'] as const)(
    'fences a console undo when its membership is %s before commit',
    async (change) => {
      const s = await scenario();
      const user = await makeUser(kit.fx);
      const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, [
        'pass_operator',
      ]);
      const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
      if (!session) throw new Error('Missing session');
      const undoKey = key();
      const race = raceBatch('UPDATE scan_gates SET state', async (db) => {
        await run(db, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
          kit.clock.now(),
          membershipId,
        ]);
        if (change !== 'revoked')
          await grantScanMembership(
            kit.fx,
            kit.org.id,
            user.id,
            change === 'downgraded' ? ['read_only'] : ['pass_operator'],
          );
      });
      await expect(
        consoleUndo(race.ctx, session, {
          scanId: s.targetId,
          orgId: kit.org.id,
          mode: 'live',
          idempotencyKey: undoKey,
          maxAgeMs: 86_400_000,
        }),
      ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
      expect(race.raced()).toBe(true);
      await expectNoUndo(s, undoKey);
      expect(
        await first(kit.env.DB, 'SELECT id FROM scans WHERE idempotency_key=?', [undoKey]),
      ).toBeNull();
      if (change === 'same-role ABA') {
        const fresh = await consoleUndo(kit.ctx, session, {
          scanId: s.targetId,
          orgId: kit.org.id,
          mode: 'live',
          idempotencyKey: key(),
          maxAgeMs: 86_400_000,
        });
        expect(fresh).toMatchObject({ kind: 'ok', replay: false });
      }
    },
  );

  it.each(['organization', 'template'] as const)(
    'undoes when the %s row is edited before commit',
    async (change) => {
      const s = await scenario();
      const race = raceBatch('UPDATE scan_gates SET state', (db) =>
        change === 'organization'
          ? run(db, "UPDATE orgs SET name='Renamed', updated_at=updated_at+1 WHERE id=?", [
              kit.org.id,
            ])
          : run(db, 'UPDATE templates SET updated_at=updated_at+1 WHERE id=?', [templateId]),
      );
      const result = await undo(race.ctx, s.actor, s.targetId, { idempotencyKey: key() });
      expect(result.outcome).toMatchObject({ kind: 'ok', replay: false });
      expect(race.raced()).toBe(true);
    },
  );

  it('does not expose a manager-only member photo to a tenant reader', async () => {
    const restricted = await kit.scanTemplate('Manager photo', {
      actions: [{ id: 'enter', label: 'Check in', kind: 'check_in' }],
      display: { v: 1, photo: { minRole: 'manager' }, header: {} },
    });
    const pass = await kit.scanPass(restricted);
    const reader = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, reader.id, ['read_only']);
    const fixture = await makeSession(kit.fx, { userId: reader.id, roles: ['user'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const actor: ScanActor = {
      ...adminActor(session, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [restricted],
        timeZone: 'UTC',
      }),
      role: tenantScanRole(authority),
      platformSessionId: session.sessionId,
      tenantAuthority: await captureScanTenantAuthority(kit.ctx, session, authority),
    };
    expect(actor.role).toBe('door');
    expect(await canShowMemberPhoto(kit.ctx, actor, pass.id)).toBe(false);

    const manager = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, manager.id);
    const managerFixture = await makeSession(kit.fx, { userId: manager.id, roles: ['user'] });
    const managerSession = await resolveSession(kit.env, kit.clock, managerFixture.cookieValue);
    if (!managerSession) throw new Error('Missing manager session');
    const managerAuthority = await tenantAuthorityOf(
      kit.ctx,
      managerSession,
      kit.org.id,
      'scanning:read',
    );
    if (managerAuthority.kind !== 'session') throw new Error('Expected session authority');
    const managerActor: ScanActor = {
      ...adminActor(managerSession, 'live', {
        orgId: kit.org.id,
        event: null,
        templateIds: [restricted],
        timeZone: 'UTC',
      }),
      role: tenantScanRole(managerAuthority),
      platformSessionId: managerSession.sessionId,
      tenantAuthority: await captureScanTenantAuthority(kit.ctx, managerSession, managerAuthority),
    };
    expect(managerActor.role).toBe('manager');
    expect(await canShowMemberPhoto(kit.ctx, managerActor, pass.id)).toBe(true);
  });
});
