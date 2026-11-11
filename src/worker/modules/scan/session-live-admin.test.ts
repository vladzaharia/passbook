import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { adminActor, captureScanTenantAuthority } from './actor.ts';
import { createScannerStore } from './auth-store.ts';
import { scanHub } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import { asDeskDisplay } from './live-screen-test-fixtures.ts';
import { scanPhotoUrl } from './member-photo-url.ts';
import { getEvent } from './repo-scope.ts';
import { joinAdminScanningSession, updateScanningDevice } from './scanning-devices.ts';
import {
  managedScreenAttachment,
  type SessionLiveFixtures,
  sessionLiveFixtures,
} from './session-live-test-fixtures.ts';
import { grantScanMembership, proofedScanActor } from './test-kit.ts';

let fixtures: SessionLiveFixtures;
beforeAll(async () => {
  fixtures = await sessionLiveFixtures();
});

describe('administrator session display authorization', () => {
  it('allows an administrator device to use a customer display and revalidates its real platform session', async () => {
    const { kit, parent } = fixtures;
    const session = await parent('Admin customer display session');
    const user = await makeUser(kit.fx);
    const membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
    const auth = await makeSession(kit.fx, { userId: user.id, roles: ['admin'] });
    const resolved = await createSessionStore(kit.env, kit.clock).resolve(auth.cookieValue);
    if (!resolved) throw new Error('Missing admin session.');
    const updateAuthority = await tenantAuthorityOf(
      kit.ctx,
      resolved,
      kit.org.id,
      'scanning:manage',
    );
    const joined = await joinAdminScanningSession(
      kit.ctx,
      user.id,
      'live',
      { sessionId: session.id, deviceKey: '33333333-3333-4333-8333-333333333333' },
      'https://wallet.test',
      updateAuthority,
    );
    const device = await updateScanningDevice(
      kit.ctx,
      user.id,
      session.id,
      joined.setupId,
      { surface: 'customer' },
      updateAuthority,
    );
    const { attachment } = await managedScreenAttachment(kit, resolved, device.id);
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    expect(
      await liveRecipient(kit.ctx, {
        ...attachment,
        admin: { ...attachment.admin!, userId: 'other-admin' },
      }),
    ).toBeNull();
    const revokedMembership = await run(
      kit.env.DB,
      'UPDATE org_memberships SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
      [kit.clock.now(), membershipId],
    );
    expect(revokedMembership.changes).toBe(1);
    expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
    await grantScanMembership(kit.fx, kit.org.id, user.id);
    expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
    const refreshed = (await managedScreenAttachment(kit, resolved, device.id)).attachment;
    expect(await liveRecipient(kit.ctx, refreshed)).not.toBeNull();
    await revokeSession(kit.env.DB, attachment.admin!.sessionId, kit.clock.now());
    expect(await liveRecipient(kit.ctx, refreshed)).toBeNull();
  });

  it('preserves managed-admin scope on monitor photos and rejects a revoked admin session', async () => {
    const { kit, authority, parent, child, row, withSourceProof } = fixtures;
    const session = await parent('Admin monitor photo session');
    const source = await child(session.id, 'Photo source');
    const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
      code: source.pairing?.code,
    });
    expect(paired.status).toBe(200);
    const joined = await joinAdminScanningSession(
      kit.ctx,
      'admin-1',
      'live',
      { sessionId: session.id, deviceKey: '44444444-4444-4444-8444-444444444444' },
      'https://wallet.test',
      authority,
    );
    const device = await updateScanningDevice(
      kit.ctx,
      'admin-1',
      session.id,
      joined.setupId,
      { surface: 'desk' },
      authority,
    );
    await asDeskDisplay(kit.env.DB, device.id);
    const auth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
    const sessionAuth = await createSessionStore(kit.env, kit.clock).resolve(auth.cookieValue);
    if (!sessionAuth) throw new Error('Missing admin session.');
    const { attachment, tenantAuthority } = await managedScreenAttachment(
      kit,
      sessionAuth,
      device.id,
    );
    const recipient = await liveRecipient(kit.ctx, attachment);
    if (!recipient) throw new Error('Missing admin monitor recipient.');
    const template = await kit.scanTemplate('Admin monitor photo', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const pass = await kit.scanPass(template);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const entry = await withSourceProof({ ...row(source.id), passId: pass.id });
    expect(
      await scanHub(kit.ctx, kit.org.id, 'live').publish({
        orgId: kit.org.id,
        mode: 'live',
        row: entry,
      }),
    ).toBe(true);
    const projection = await liveRowFor(kit.ctx, recipient, entry);
    if (!projection?.photoUrl) throw new Error('Missing admin monitor photo.');
    const url = new URL(projection.photoUrl, 'https://wallet.test');
    expect([...url.searchParams.keys()].sort()).toEqual([
      'event',
      'g',
      'orgId',
      'setupId',
      'timeZone',
    ]);
    expect(url.searchParams.get('event')).toBe(entry.id);
    expect(url.toString()).not.toContain(entry.sourceProof);
    expect(url.toString()).not.toContain(attachment.admin!.sessionId);
    expect(url.toString()).not.toContain(tenantAuthority.membershipId);
    expect(JSON.stringify(projection)).not.toMatch(
      /sourceProof|platformSessionId|passSnapshot|linkGeneration|identityRevision/,
    );
    expect(url.searchParams.get('orgId')).toBe(kit.org.id);
    expect(url.searchParams.get('setupId')).toBe(device.id);
    expect(url.searchParams.get('timeZone')).toBe('UTC');
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    expect((await app.request(url.toString(), { headers: auth.headers }, kit.env)).status).toBe(
      200,
    );
    await revokeSession(kit.env.DB, attachment.admin!.sessionId, kit.clock.now());
    expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
    expect((await app.request(url.toString(), { headers: auth.headers }, kit.env)).status).toBe(
      401,
    );
  });

  it('retains an unbound admin event and template scope in ordinary member-photo URLs', async () => {
    const { kit } = fixtures;
    const template = await kit.scanTemplate('Scoped admin photo', {
      actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
    });
    const madeEvent = await kit.event({ templateIds: [template] });
    const event = await getEvent(kit.env.DB, kit.org.id, madeEvent.id);
    const auth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
    const store = createSessionStore(kit.env, kit.clock);
    const session = await store.resolve(auth.cookieValue);
    if (!event || !session) throw new Error('Missing scoped admin fixture.');
    const readAuthority = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
    if (readAuthority.kind !== 'session') throw new Error('Expected session authority.');
    const tenantAuthority = await captureScanTenantAuthority(kit.ctx, session, readAuthority);
    const actor = adminActor(session, 'live', {
      orgId: kit.org.id,
      event,
      templateIds: [template],
      timeZone: event.timeZone,
    });
    actor.platformSessionId = session.sessionId;
    actor.tenantAuthority = tenantAuthority;
    const proofed = await proofedScanActor(kit.ctx, actor);
    const pass = await kit.scanPass(template);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const photo = await scanPhotoUrl(kit.ctx, proofed, pass.id);
    if (!photo) throw new Error('Missing scoped admin photo.');
    const url = new URL(photo, 'https://wallet.test');
    expect(url.searchParams.get('orgId')).toBe(kit.org.id);
    expect(url.searchParams.get('eventId')).toBe(event.id);
    expect(url.searchParams.get('templateIds')).toBe(template);
    expect(url.searchParams.get('timeZone')).toBe(event.timeZone);
    expect(url.toString()).not.toContain(session.sessionId);
    expect(url.toString()).not.toContain(tenantAuthority.membershipId);
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: store,
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    expect((await app.request(url.toString(), { headers: auth.headers }, kit.env)).status).toBe(
      200,
    );
  });
});
