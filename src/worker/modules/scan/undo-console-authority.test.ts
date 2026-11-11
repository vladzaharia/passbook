import { describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { resolveSession } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { adminActor, captureScanTenantAuthority, type ScanActor, tenantScanRole } from './actor.ts';
import { captureScanEpochs } from './authority-checks.ts';
import { expectNoUndo, kit, scenario, templateId } from './repo-undo-authority-test-fixtures.ts';
import { grantScanMembership, key } from './test-kit.ts';
import { consoleUndo, undo } from './undo.ts';

describe('console undo authority', () => {
  it("retries a console undo of another scanner's scan with the same key", async () => {
    const s = await scenario();
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    const input = {
      scanId: s.targetId,
      orgId: kit.org.id,
      mode: 'live' as const,
      idempotencyKey: key(),
      maxAgeMs: 86_400_000,
    };
    const done = await consoleUndo(kit.ctx, session, input);
    expect(await consoleUndo(kit.ctx, session, input)).toMatchObject({
      kind: 'ok',
      replay: true,
      scanId: done.scanId,
    });
  });

  it('gives the same code for an event archived before the request as during it', async () => {
    const event = await kit.event({ templateIds: [templateId] });
    const s = await scenario(event.id);
    await run(kit.env.DB, 'UPDATE scan_events SET archived_at=1 WHERE id=?', [event.id]);
    const user = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
    const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
    const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
    if (!session) throw new Error('Missing session');
    await expect(
      consoleUndo(kit.ctx, session, {
        scanId: s.targetId,
        orgId: kit.org.id,
        mode: 'live',
        idempotencyKey: key(),
        maxAgeMs: 86_400_000,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'SCAN_CONFIG_CHANGED' });
  });

  it('undoes a console scan whose captured org revision is a pre-cutover updated_at, until the org is suspended', async () => {
    const preCutover = 1_700_000_000_000;
    const operator = async () => {
      const s = await scenario();
      const user = await makeUser(kit.fx);
      await grantScanMembership(kit.fx, kit.org.id, user.id, ['pass_operator']);
      const fixture = await makeSession(kit.fx, { userId: user.id, roles: ['user'] });
      const session = await resolveSession(kit.env, kit.clock, fixture.cookieValue);
      if (!session) throw new Error('Missing session');
      const authority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'passes:operate');
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
        tenantAuthority: {
          ...(await captureScanTenantAuthority(kit.ctx, session, authority)),
          orgUpdatedAt: preCutover,
        },
      };
      await captureScanEpochs(kit.env.DB, actor);
      return { s, actor };
    };
    const active = await operator();
    expect(
      (await undo(kit.ctx, active.actor, active.s.targetId, { idempotencyKey: key() })).outcome,
    ).toMatchObject({ kind: 'ok', replay: false });
    const suspended = await operator();
    await run(kit.env.DB, "UPDATE orgs SET status='suspended' WHERE id=?", [kit.org.id]);
    const undoKey = key();
    await expect(
      undo(kit.ctx, suspended.actor, suspended.s.targetId, { idempotencyKey: undoKey }),
    ).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
    await expectNoUndo(suspended.s, undoKey);
  });
});
