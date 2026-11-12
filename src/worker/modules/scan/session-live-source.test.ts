import { beforeAll, describe, expect, it, vi } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { revokeMembership } from '../orgs/repo-members.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { memberPhoto } from '../passes/repo-member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { act } from './act.ts';
import { captureScanTenantAuthority } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { publishScan, scanHub } from './live.ts';
import { liveRecipient } from './live-auth.ts';
import { livePassSnapshot, openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import { liveRowFor } from './live-render.ts';
import { getScanner } from './repo-device.ts';
import { resolveOutcome } from './resolve-outcome.ts';
import { createScanningDevice, joinAdminScanningSession } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession, updateScanningSession } from './scanning-sessions.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { pairedScreenAttachment } from './session-live-test-fixtures.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  proofedScanActor,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await ensureCredentialRefKeyset(kit.env.DB, kit.env);
});
async function sourceAuthority(admin: SessionAuth, capability: 'scanning:read' | 'passes:operate') {
  const authority = await tenantAuthorityOf(kit.ctx, admin, kit.org.id, capability);
  if (authority.kind !== 'session') throw new Error('Missing source session authority.');
  return captureScanTenantAuthority(kit.ctx, admin, authority);
}
async function managedSource(admin: SessionAuth, setupId: string) {
  const source = await managedAdminActor(kit.ctx, admin, 'live', kit.org.id, setupId);
  source.platformSessionId = admin.sessionId;
  source.tenantAuthority = await sourceAuthority(admin, 'passes:operate');
  // Like the guard: bind the workspace first, so the captured epochs include its session.
  await bindScanningSession(kit.ctx, source);
  return proofedScanActor(kit.ctx, source);
}
const parent = async (name: string, authority: TenantPassWrite, admin: SessionAuth) =>
  createScanningSession(
    kit.ctx,
    'admin-1',
    'live',
    CreateScanningSessionSchema.parse({
      orgId: kit.org.id,
      name,
      timeZone: 'UTC',
      settings: { staffSignIn: true },
    }),
    authority,
    await captureConsoleSessionCountAuthority(
      kit.ctx,
      admin,
      await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:read'),
    ),
  );
const child = (
  sessionId: string,
  name: string,
  authority: TenantPassWrite,
  surface: 'phone' | 'desk' | 'customer' = 'phone',
) =>
  createScanningDevice(
    kit.ctx,
    'admin-1',
    'live',
    sessionId,
    { name, surface, overrides: {} },
    'https://wallet.test',
    authority,
  );

describe('administrator source authority', () => {
  it('uses the originating admin session as source authority for a paired monitor photo', async () => {
    const auth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
    const admin = await createSessionStore(kit.env, kit.clock).resolve(auth.cookieValue);
    if (!admin) throw new Error('Missing admin source session.');
    const manage = await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:manage');
    if (manage.kind !== 'session') throw new Error('Missing session management authority.');
    let membershipId = manage.membershipId;
    const session = await parent('Admin source photo session', manage, admin);
    const joined = await joinAdminScanningSession(
      kit.ctx,
      'admin-1',
      'live',
      { sessionId: session.id, deviceKey: '55555555-5555-4555-8555-555555555555' },
      'https://wallet.test',
      manage,
    );
    const screen = await child(session.id, 'Paired monitor', manage, 'desk');
    const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
      code: screen.pairing?.code,
    });
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get('set-cookie')?.split(';')[0];
    const monitor = await getScanner(kit.env.DB, screen.id);
    if (!cookie || !monitor?.tokenHash || !monitor.csrfSecret || !monitor.expiresAt)
      throw new Error('Missing paired monitor credentials.');
    const attachment = await pairedScreenAttachment(kit, monitor.id, cookie);
    const source = await managedSource(admin, joined.setupId);
    if (!source.scanner || !source.tenantAuthority || !attachment.scannerCsrfProof)
      throw new Error('Missing source or monitor proof.');
    expect(source.scanner.csrfSecret).toBeNull();
    const sourceCsrfProof = source.tenantAuthority.sessionCsrfProof;
    const monitorCsrfProof = attachment.scannerCsrfProof;
    const recipient = await liveRecipient(kit.ctx, attachment);
    if (!recipient) throw new Error('Missing paired monitor recipient.');
    expect(recipient.actor.role).toBeNull();
    const template = await kit.scanTemplate('Admin source photo', {
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
    const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, source, {
      input: codeOf(pass),
      actionId: 'check_in',
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(outcome.kind).toBe('ok');
    publishScan(kit.ctx, source, outcome, evaluatedSnapshot, credentialContext, 'camera');
    await kit.settle();
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    const projection = (await hub.snapshot(attachment)).rows.find(
      (item) => item.scannerId === joined.setupId,
    );
    if (!projection?.photoUrl) throw new Error('Missing admin-source monitor photo.');
    expect(projection).toMatchObject({ passId: pass.id, holder: 'Anna Popescu' });
    expect(projection.id).not.toBe(outcome.scanId);
    const sourceProof = await hub.sourceProof(projection.id);
    if (!sourceProof || !evaluatedSnapshot)
      throw new Error('Missing source proof or evaluated pass.');
    const opened = await openLiveSourceProof(kit.env, sourceProof);
    expect(JSON.stringify(opened)).not.toContain(auth.csrf);
    expect(JSON.stringify(opened)).not.toContain(monitor.csrfSecret);
    expect(opened).toEqual({
      actor: source,
      eventId: projection.id,
      credentialContext,
      passId: pass.id,
      passSnapshot: await livePassSnapshot(kit.env, evaluatedSnapshot),
      at: projection.at,
    });
    expect(projection).not.toHaveProperty('sourceProof');
    expect(JSON.stringify(projection)).not.toContain(admin.sessionId);
    expect(JSON.stringify(projection)).not.toContain(membershipId);
    expect(JSON.stringify(projection)).not.toContain(auth.csrf);
    expect(JSON.stringify(projection)).not.toContain(sourceProof);
    expect(JSON.stringify(projection)).not.toContain(sourceCsrfProof);
    expect(JSON.stringify(projection)).not.toContain(monitorCsrfProof);
    expect(JSON.stringify(projection)).not.toContain(monitor.csrfSecret);
    expect(recipient.actor.role).toBeNull();
    const params = new URL(projection.photoUrl, 'https://wallet.test').searchParams;
    expect([...params.keys()].sort()).toEqual(['event', 'g']);
    expect(params.get('event')).toBe(projection.id);
    expect(params.toString()).not.toContain(admin.sessionId);
    expect(params.toString()).not.toContain(membershipId);
    expect(params.toString()).not.toContain(auth.csrf);
    expect(params.toString()).not.toContain(sourceCsrfProof);
    expect(params.toString()).not.toContain(monitorCsrfProof);
    expect(params.toString()).not.toContain(monitor.csrfSecret);
    const path = projection.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get({ cookie }, path)).status).toBe(200);
    await expect(
      run(kit.env.DB, 'UPDATE sessions SET csrf_secret = ? WHERE id_hash = ?', [
        'attempted-session-secret-rotation',
        admin.sessionId,
      ]),
    ).rejects.toThrow();
    expect((await kit.get({ cookie }, path)).status).toBe(200);
    const otherAuth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
    const otherAdmin = await createSessionStore(kit.env, kit.clock).resolve(otherAuth.cookieValue);
    if (!otherAdmin || !opened || !source.tenantAuthority)
      throw new Error('Missing session lineage.');
    expect(otherAdmin.csrfSecret).not.toBe(admin.csrfSecret);
    const otherAuthority = await sourceAuthority(otherAdmin, 'passes:operate');
    const swapped = await sealLiveSourceProof(kit.env, {
      ...opened,
      actor: {
        ...opened.actor,
        platformSessionId: otherAdmin.sessionId,
        tenantAuthority: {
          ...otherAuthority,
          sessionCsrfProof: source.tenantAuthority.sessionCsrfProof,
        },
      },
    });
    // A proof re-bound to another session fails the source CSRF fence: the event is omitted.
    const swappedRow = { ...projection, sourceProof: swapped };
    expect(await liveRowFor(kit.ctx, recipient, swappedRow)).toBeNull();
    const genuineRow = { ...projection, sourceProof };
    expect(await liveRowFor(kit.ctx, recipient, genuineRow)).toMatchObject({ passId: pass.id });
    // The last org admin cannot be revoked: add another first.
    await grantScanMembership(kit.fx, kit.org.id, (await makeUser(kit.fx)).id);
    const revokedMembership = await revokeMembership(
      kit.env.DB,
      kit.org.id,
      membershipId,
      kit.clock.now(),
      'admin-1',
      true,
    ).run();
    expect(revokedMembership.meta.changes).toBe(1);
    expect((await kit.get({ cookie }, path)).status).toBe(404);
    membershipId = await grantScanMembership(kit.fx, kit.org.id, 'admin-1');
    expect((await kit.get({ cookie }, path)).status).toBe(404);
    // The source's membership was revoked: its retained events are omitted, not replayed.
    const stale = (await hub.snapshot(attachment)).rows.find((item) => item.id === projection.id);
    expect(stale).toBeUndefined();
    source.tenantAuthority = await sourceAuthority(admin, 'scanning:read');
    const renewedEvaluation = await resolveOutcome(kit.ctx, source, {
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      idempotencyKey: key(),
    });
    expect(renewedEvaluation.outcome.kind).toBe('ready');
    publishScan(
      kit.ctx,
      source,
      renewedEvaluation.outcome,
      renewedEvaluation.evaluatedSnapshot,
      renewedEvaluation.credentialContext,
      'camera',
    );
    await kit.settle();
    const fresh = (await hub.snapshot(attachment)).rows.find(
      (item) => item.scannerId === joined.setupId && item.id !== projection.id,
    );
    if (!fresh?.photoUrl) throw new Error('Missing renewed admin-source photo.');
    const freshPath = fresh.photoUrl.replace('/api/v1/scan', '');
    expect((await kit.get({ cookie }, freshPath)).status).toBe(200);
    const stored = await memberPhoto(kit.env.DB, kit.org.id, pass.id);
    if (!stored) throw new Error('Missing admin-source photo object.');
    const originalGet = kit.env.BUCKET.get.bind(kit.env.BUCKET);
    let openedStream = false;
    let cancelled = 0;
    const spy = vi.spyOn(kit.env.BUCKET, 'get').mockImplementation(async (objectKey, options) => {
      const object = await originalGet(objectKey, options);
      if (objectKey !== stored.r2_key || !object) return object;
      openedStream = true;
      await revokeSession(kit.env.DB, admin.sessionId, kit.clock.now());
      const reader = object.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            const result = await reader.read();
            if (result.done) controller.close();
            else controller.enqueue(result.value);
          },
          async cancel(reason) {
            cancelled++;
            await reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      return new Proxy(object, {
        get(target, property) {
          if (property === 'body') return body;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      expect((await kit.get({ cookie }, freshPath)).status).toBe(404);
    } finally {
      spy.mockRestore();
    }
    expect(openedStream).toBe(true);
    expect(cancelled).toBe(1);
    const revoked = (await hub.snapshot(attachment)).rows.find((item) => item.id === fresh.id);
    expect(revoked).toBeUndefined();
  });

  it.each(['paused', 'ended'] as const)(
    'stops a retained admin-source photo when the scanning session is %s',
    async (status) => {
      const auth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
      const admin = await createSessionStore(kit.env, kit.clock).resolve(auth.cookieValue);
      if (!admin) throw new Error('Missing admin source session.');
      const manage = await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:manage');
      const session = await parent(`Source session ${status}`, manage, admin);
      const joined = await joinAdminScanningSession(
        kit.ctx,
        'admin-1',
        'live',
        { sessionId: session.id, deviceKey: '66666666-6666-4666-8666-666666666666' },
        'https://wallet.test',
        manage,
      );
      const screen = await child(session.id, `Session monitor ${status}`, manage, 'desk');
      const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
        code: screen.pairing?.code,
      });
      expect(paired.status).toBe(200);
      const cookie = paired.headers.get('set-cookie')?.split(';')[0];
      const monitor = await getScanner(kit.env.DB, screen.id);
      if (!cookie || !monitor?.tokenHash || !monitor.csrfSecret || !monitor.expiresAt)
        throw new Error('Missing paired monitor credentials.');
      const attachment = await pairedScreenAttachment(kit, monitor.id, cookie);
      const source = await managedSource(admin, joined.setupId);
      const template = await kit.scanTemplate(`Session ${status} photo`, {
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
      const { outcome, evaluatedSnapshot, credentialContext } = await act(kit.ctx, source, {
        input: codeOf(pass),
        actionId: 'check_in',
        clientTs: kit.clock.now(),
        idempotencyKey: key(),
      });
      expect(outcome.kind).toBe('ok');
      publishScan(kit.ctx, source, outcome, evaluatedSnapshot, credentialContext, 'camera');
      await kit.settle();
      const hub = scanHub(kit.ctx, kit.org.id, 'live');
      const projection = (await hub.snapshot(attachment)).rows.find(
        (item) => item.scannerId === joined.setupId,
      );
      if (!projection?.photoUrl) throw new Error('Missing session photo.');
      const path = projection.photoUrl.replace('/api/v1/scan', '');
      expect((await kit.get({ cookie }, path)).status).toBe(200);
      await updateScanningSession(
        kit.ctx,
        'admin-1',
        session.id,
        { status },
        manage,
        await captureConsoleSessionCountAuthority(
          kit.ctx,
          admin,
          await tenantAuthorityOf(kit.ctx, admin, kit.org.id, 'scanning:read'),
        ),
      );
      expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
      expect((await hub.snapshot(attachment)).rows).toEqual([]);
      expect((await kit.get({ cookie }, path)).status).toBe(404);
    },
  );
});
