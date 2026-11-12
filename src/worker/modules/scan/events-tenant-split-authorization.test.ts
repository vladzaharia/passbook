import { describe, expect, it } from 'vitest';
import {
  makeScanEvent,
  makeScanner,
  makeTemplate,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { ProblemSchema, ScanEventSchema } from '../../../shared/contracts/index.ts';
import { run } from '../../platform/db.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { captureEventAuthority } from './events.ts';
import { archiveEvent, assignScanners, createEvent, updateEvent } from './events-mutations.ts';
import {
  attachedScannerId,
  call,
  clock,
  env,
  eventId,
  f,
  HOUR,
  input,
  member,
  orgId,
  otherEventId,
  otherOrgId,
  page,
  templateId,
} from './events-tenant-split-test-fixtures.ts';
import { state } from './repo-events-tenant-state-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

describe('scan event tenant routes', () => {
  it('masks other organizations on list, detail and all resource mutations', async () => {
    const foreignScanner = await makeScanner(f, { orgId: otherOrgId });
    const foreignTemplate = makeTemplate({ id: f.ids.id(), orgId: otherOrgId });
    await persistTemplate(f, foreignTemplate.resolved, { registry: foreignTemplate.registry });
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: foreignTemplate.registry },
      {
        orgId: otherOrgId,
        templateId: foreignTemplate.resolved.id,
        version: foreignTemplate.resolved.version,
        mode: 'live',
      },
    );
    const before = await state();
    expect(await page(await call(member, 'GET', `?orgId=${otherOrgId}`))).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await page(await call(member, 'GET', `?orgId=${orgId}&cursor=${otherEventId}`))).toEqual(
      {
        items: [],
        nextCursor: null,
      },
    );
    expect((await call(member, 'GET', `/${otherEventId}`)).status).toBe(404);
    expect((await call(member, 'PATCH', `/${otherEventId}`, { name: 'Changed' })).status).toBe(404);
    expect((await call(member, 'POST', `/${otherEventId}/archive`)).status).toBe(404);
    expect(
      (await call(member, 'POST', `/${otherEventId}/scanners`, { scannerIds: [attachedScannerId] }))
        .status,
    ).toBe(404);
    expect(
      (await call(member, 'POST', `/${eventId}/scanners`, { scannerIds: [foreignScanner.id] }))
        .status,
    ).toBe(404);
    expect(
      (await call(member, 'PATCH', `/${eventId}`, { templateIds: [foreignTemplate.resolved.id] }))
        .status,
    ).toBe(404);
    const create = await call(member, 'POST', '', input(otherOrgId));
    expect(create.status).toBe(404);
    expect(ProblemSchema.parse(await create.json()).code).toBe('ORG_NOT_FOUND');
    expect((await call(member, 'GET', '')).status).toBe(403);
    expect(await state()).toEqual(before);
  });

  it('checks the actual event scope before mutation validation, even for direct service calls', async () => {
    const ctx = createServiceContext(env, { clock });
    const auth = await createSessionStore(env, clock).resolve(member.cookieValue);
    if (!auth) throw new Error('Missing tenant session.');
    const authority = await captureEventAuthority(
      ctx,
      auth,
      await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage'),
    );
    if (authority.kind !== 'session') throw new Error('Expected session authority.');
    await run(env.DB, 'UPDATE scan_events SET archived_at=? WHERE id=?', [
      clock.now(),
      otherEventId,
    ]);
    const wrongMode = await makeScanEvent(f, { orgId, mode: 'test', templateIds: [templateId] });
    const before = await state();
    await expect(
      updateEvent(
        ctx,
        member.userId,
        otherEventId,
        {
          opensAt: clock.now() + 10 * HOUR,
        },
        authority,
      ),
    ).rejects.toMatchObject({ status: 404, code: 'EVENT_NOT_FOUND' });
    await expect(archiveEvent(ctx, member.userId, otherEventId, authority)).rejects.toMatchObject({
      status: 404,
      code: 'EVENT_NOT_FOUND',
    });
    await expect(
      assignScanners(ctx, member.userId, otherEventId, { scannerIds: [] }, authority),
    ).rejects.toMatchObject({ status: 404, code: 'EVENT_NOT_FOUND' });
    await expect(
      updateEvent(ctx, member.userId, wrongMode.id, { name: 'Wrong mode' }, authority),
    ).rejects.toMatchObject({ status: 404, code: 'EVENT_NOT_FOUND' });
    await expect(
      createEvent(ctx, member.userId, 'live', input(otherOrgId), authority),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(
      updateEvent(
        ctx,
        member.userId,
        eventId,
        { name: 'Unauthorized' },
        {
          ...authority,
          capability: 'scanning:read',
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(
      updateEvent(ctx, 'different-user', eventId, { name: 'Unauthorized' }, authority),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await run(env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      clock.now(),
      authority.membershipId,
    ]);
    await expect(createEvent(ctx, member.userId, 'live', input(), authority)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(archiveEvent(ctx, member.userId, eventId, authority)).rejects.toMatchObject({
      status: 403,
    });
    expect(await state()).toEqual(before);
  });

  it('uses organization-specific approvals for shared event templates', async () => {
    const shared = makeTemplate({ id: f.ids.id(), orgId: null });
    await persistTemplate(f, shared.resolved, { registry: shared.registry });
    await approveAppleRelease(
      { ctx: createServiceContext(env, { clock }), fx: f, registry: shared.registry },
      { orgId, templateId: shared.resolved.id, version: shared.resolved.version, mode: 'live' },
    );
    const created = await call(member, 'POST', '', {
      ...input(),
      templateIds: [shared.resolved.id],
    });
    expect(created.status).toBe(201);
    expect(ScanEventSchema.parse(await created.json()).templateIds).toEqual([shared.resolved.id]);
    await grantScanMembership(f, otherOrgId, member.userId);
    const foreign = await call(member, 'POST', '', {
      ...input(otherOrgId),
      templateIds: [shared.resolved.id],
    });
    expect(foreign.status).toBe(422);
    expect(ProblemSchema.parse(await foreign.json()).code).toBe('EVENT_TEMPLATE_RELEASE_REQUIRED');
  });
});
