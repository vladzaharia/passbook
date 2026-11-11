import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { ScanLiveSnapshotSchema } from '../../../shared/contracts/scan-setups.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { type ScanTenantAuthority, scanSessionCsrfProof } from './actor.ts';
import { liveAttachment } from './live.ts';
import { openLiveAttachment, sealLiveAttachment } from './live-attachment.ts';
import { liveRecipient } from './live-auth.ts';
import { liveTenantFixture, ORIGIN } from './live-tenant-test-fixtures.ts';
import { storedSession } from './repo-live-tenant-db-test-fixtures.ts';
import { captureObservedScanningSession } from './scanning-workspace-observation.ts';
import { grantScanMembership, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, attachmentForSession, hub, provenRow, assertClosed } = fixture;
let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  ({ kit, app, credentialKeysetCommitment } = await fixture.setup());
});

describe('user-backed live tenant authority', () => {
  it.each([
    { role: 'read_only', platformRoles: ['admin', 'user'], expected: 'door' },
    { role: 'pass_operator', platformRoles: ['admin', 'user'], expected: 'desk' },
    { role: 'org_admin', platformRoles: ['user'], expected: 'manager' },
  ] as const)(
    'preserves a $role tenant snapshot and returns the $expected role',
    async ({ role, platformRoles, expected }) => {
      const screen = await managedScreen({ role, platformRoles: [...platformRoles] });
      expect(
        JSON.stringify(screen.attachment.admin) ===
          JSON.stringify({
            sessionId: screen.resolved.sessionId,
            userId: screen.user.id,
            tenantAuthority: screen.authority,
          }),
      ).toBe(true);
      expect(screen.attachment.credentialKeysetCommitment === credentialKeysetCommitment).toBe(
        true,
      );
      expect(screen.attachment.scannerCsrfProof == null).toBe(true);
      expect(screen.attachment.session).toEqual(screen.actor.scanningSession);
      expect(screen.attachment.session).toMatchObject({
        id: screen.workspace.id,
        status: 'active',
      });
      expect(screen.attachment.actor.tenantAuthority).toEqual(screen.authority);
      expect(screen.attachment.actor.scanner?.csrfSecret).toBeNull();
      expect(screen.attachment.observation).toEqual(captureObservedScanningSession(screen.actor));
      expect(screen.attachment.observation).not.toBeNull();
      const sealed = await sealLiveAttachment(kit.env, screen.attachment);
      expect(sealed).not.toContain(screen.session.csrf);
      const reopened = await openLiveAttachment(kit.env, sealed);
      if (!reopened) throw new Error('Missing reopened live attachment.');
      expect(reopened.actor).toEqual(screen.attachment.actor);
      expect(reopened.observation).toEqual(screen.attachment.observation);
      expect(await liveRecipient(kit.ctx, reopened)).not.toBeNull();
      expect(
        screen.authority.orgId === kit.org.id &&
          screen.authority.mode === 'live' &&
          screen.authority.userId === screen.user.id &&
          screen.authority.sessionId === screen.resolved.sessionId &&
          screen.authority.membershipId === screen.membershipId &&
          screen.authority.capability === 'scanning:read' &&
          JSON.stringify(screen.authority.roles) === JSON.stringify([role]),
      ).toBe(true);
      const stored = await storedSession(kit, screen.resolved.sessionId);
      expect(screen.authority.sessionCreatedAt).toBe(stored.created_at);
      expect(screen.authority.sessionExpiresAt).toBe(stored.expires_at);
      expect(/^[A-Za-z0-9_-]{43}$/.test(screen.authority.sessionCsrfProof)).toBe(true);
      expect(
        screen.authority.sessionCsrfProof ===
          (await scanSessionCsrfProof(kit.env, screen.resolved.sessionId, screen.session.csrf)),
      ).toBe(true);
      expect(screen.authority.sessionCsrfProof === screen.session.csrf).toBe(false);
      expect(JSON.stringify(screen.attachment).includes(screen.session.csrf)).toBe(false);
      const recipient = await liveRecipient(kit.ctx, screen.attachment);
      expect(
        recipient?.actor.principal === 'admin' &&
          recipient.actor.orgId === kit.org.id &&
          recipient.actor.mode === 'live' &&
          recipient.actor.role === expected &&
          recipient.actor.actor.type === 'user' &&
          recipient.actor.actor.id === screen.user.id &&
          recipient.actor.platformSessionId === screen.resolved.sessionId &&
          JSON.stringify(recipient.actor.tenantAuthority) === JSON.stringify(screen.authority),
      ).toBe(true);
      expect(JSON.stringify(recipient?.actor ?? null).includes(screen.session.csrf)).toBe(false);
    },
  );

  it('refuses to create a user-backed attachment without the exact scanning:read snapshot', async () => {
    const screen = await managedScreen({ role: 'read_only' });
    const authority = screen.authority;
    const invalid: unknown[] = [
      undefined,
      null,
      { ...authority, kind: 'api_key' },
      { ...authority, orgId: 'another-org' },
      { ...authority, mode: 'test' },
      { ...authority, userId: 'another-user' },
      { ...authority, sessionId: 'another-session' },
      { ...authority, capability: 'scanning:manage' },
      { ...authority, capability: 'passes:operate' },
    ];
    for (const snapshot of invalid) {
      expect(() =>
        liveAttachment(kit.ctx, {
          ...screen.actor,
          tenantAuthority: snapshot as ScanTenantAuthority,
        }),
      ).toThrow();
    }
    expect(() =>
      liveAttachment(kit.ctx, {
        ...screen.actor,
        platformSessionId: 'another-session',
      }),
    ).toThrow();
    const detached = { ...screen.actor, scanningSession: { ...screen.actor.scanningSession! } };
    expect(() => liveAttachment(kit.ctx, detached)).toThrow();
  });

  it.each(['read_only', 'pass_operator'] as const)(
    'serves a scoped live snapshot to a %s member through GET /scan/live',
    async (role) => {
      const screen = await managedScreen({ role, platformRoles: ['user'], withSource: true });
      if (!screen.source) throw new Error('Missing paired live source.');
      const entry = await provenRow(screen.source.actor);
      expect(await hub().publish({ orgId: kit.org.id, mode: 'live', row: entry })).toBe(true);
      const query = new URLSearchParams({
        orgId: kit.org.id,
        setupId: screen.device.id,
        timeZone: 'UTC',
      });
      const url = `${ORIGIN}/api/v1/scan/live?${query}`;
      const response = await app.request(url, { headers: screen.session.headers }, kit.env);
      expect(response.status).toBe(200);
      const body = await response.text();
      const scannerSecret = screen.source.csrfSecret;
      if (!scannerSecret) throw new Error('Missing scanner credential.');
      const scannerProof = screen.source.actor.scannerCsrfProof;
      if (!scannerProof) throw new Error('Missing scanner proof.');
      expect(body.includes(screen.session.csrf)).toBe(false);
      expect(body.includes(scannerSecret)).toBe(false);
      expect(body.includes(screen.authority.sessionCsrfProof)).toBe(false);
      expect(body.includes(scannerProof)).toBe(false);
      expect(body.includes(screen.resolved.sessionId)).toBe(false);
      expect(body.includes(screen.membershipId)).toBe(false);
      expect(
        /tenantAuthority|sourceProof|platformSessionId|scannerCsrfProof|sessionCsrfProof/.test(
          body,
        ),
      ).toBe(false);
      const snapshot = ScanLiveSnapshotSchema.parse(JSON.parse(body));
      const displayed = snapshot.rows[0];
      expect(
        snapshot.rows.length === 1 &&
          displayed?.id === entry.id &&
          displayed.scannerId === screen.source.device.id &&
          displayed.holder === null &&
          displayed.passId === null,
      ).toBe(true);
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        screen.membershipId,
      ]);
      const denied = await app.request(url, { headers: screen.session.headers }, kit.env);
      expect(denied.status).toBe(403);
      const deniedBody = await denied.text();
      expect(deniedBody.includes(entry.id)).toBe(false);
      expect(deniedBody.includes(screen.resolved.sessionId)).toBe(false);
      expect(deniedBody.includes(screen.membershipId)).toBe(false);
      expect(deniedBody.includes(screen.session.csrf)).toBe(false);
      expect(deniedBody.includes(scannerSecret)).toBe(false);
    },
  );

  it('does not give a platform administrator implicit access to the screen owner’s tenant', async () => {
    const screen = await managedScreen();
    const outsider = await makeUser(kit.fx);
    const session = await makeSession(kit.fx, { userId: outsider.id, roles: ['admin', 'user'] });
    const resolved = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!resolved) throw new Error('Missing outsider platform session.');
    await expect(
      tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:read'),
    ).rejects.toThrow();
    // Obtain an authentic outsider attachment, then remove its explicit tenant access.
    const outsiderMembership = await grantScanMembership(kit.fx, kit.org.id, outsider.id);
    await run(kit.env.DB, 'UPDATE scanner_setups SET admin_user_id=? WHERE scanner_id=?', [
      outsider.id,
      screen.device.id,
    ]);
    await run(kit.env.DB, 'UPDATE scanning_devices SET admin_user_id=? WHERE scanner_id=?', [
      outsider.id,
      screen.device.id,
    ]);
    const outsiderAttachment = await attachmentForSession(screen, resolved);
    expect(await liveRecipient(kit.ctx, outsiderAttachment)).not.toBeNull();
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      outsiderMembership,
    ]);
    await assertClosed(outsiderAttachment);
    const query = new URLSearchParams({
      orgId: kit.org.id,
      setupId: screen.device.id,
      timeZone: 'UTC',
    });
    const response = await app.request(
      `${ORIGIN}/api/v1/scan/live?${query}`,
      { headers: session.headers },
      kit.env,
    );
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body.includes(resolved.sessionId)).toBe(false);
    expect(body.includes(screen.membershipId)).toBe(false);
    expect(body.includes(session.csrf)).toBe(false);
  });
});
