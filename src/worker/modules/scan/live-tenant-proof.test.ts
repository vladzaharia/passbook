import { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiKeyFixture,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { type AppBindings, requestContext } from '../../platform/context.ts';
import { serviceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  authOf,
  requireTenantSessionOrApiKey,
  type TenantPassWrite,
  tenantAuthorityOf,
} from '../passes/http.ts';
import { tenantPassAuthorityValid } from '../passes/repo-authority.ts';
import { scanScannerCsrfProof, scanSessionCsrfProof } from './actor.ts';
import { liveRecipient } from './live-auth.ts';
import { liveTenantFixture, ORIGIN } from './live-tenant-test-fixtures.ts';
import { grantScanMembership, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, sessionAuthority, replaceAuthority, hub, assertClosed } = fixture;
let kit: ScanKit;
beforeAll(async () => {
  ({ kit } = await fixture.setup());
});

/** Capture key authority through the real key store and tenant scope middleware. */
async function captureKeyAuthority(key: ApiKeyFixture): Promise<TenantPassWrite> {
  const scoped = new OpenAPIHono<AppBindings>();
  const captured: { value: TenantPassWrite | null } = { value: null };
  scoped.use(
    '*',
    requestContext({
      clock: kit.clock,
      stores: (env) => ({ ...denyAllStores, apiKeys: createApiKeyStore(env, kit.clock) }),
    }),
  );
  scoped.post('/capture', requireTenantSessionOrApiKey('scans:read'), async (c) => {
    captured.value = await tenantAuthorityOf(
      serviceContext(c),
      authOf(c),
      kit.org.id,
      'scanning:read',
    );
    return c.json({ ok: true });
  });
  const response = await scoped.request(
    `${ORIGIN}/capture`,
    { method: 'POST', headers: key.headers },
    kit.env,
  );
  expect(response.status).toBe(200);
  if (!captured.value) throw new Error('Real API key did not acquire tenant scope.');
  return captured.value;
}

describe('user-backed live tenant proof validation', () => {
  it('rejects missing, API-key and forged snapshots without returning live data', async () => {
    const screen = await managedScreen({ role: 'read_only' });
    expect(await liveRecipient(kit.ctx, screen.attachment)).not.toBeNull();
    const authority = screen.authority;
    const alternateProof = await scanSessionCsrfProof(
      kit.env,
      screen.resolved.sessionId,
      kit.fx.ids.token(),
    );
    const wrongDomain = await scanScannerCsrfProof(
      kit.env,
      screen.resolved.sessionId,
      screen.session.csrf,
    );
    const forged: [string, unknown][] = [
      ['missing', undefined],
      ['null', null],
      ['empty', {}],
      ['API key', { ...authority, kind: 'api_key' }],
      ['organization', { ...authority, orgId: 'another-org' }],
      ['mode', { ...authority, mode: 'test' }],
      ['user', { ...authority, userId: 'another-user' }],
      ['session', { ...authority, sessionId: 'another-session' }],
      ['membership', { ...authority, membershipId: 'another-membership' }],
      ['organization revision', { ...authority, orgUpdatedAt: authority.orgUpdatedAt + 1 }],
      // Session roles and amr are immutable (0047) and not compared: a well-formed change is moot.
      ['missing session creation', { ...authority, sessionCreatedAt: undefined }],
      [
        'forged session creation',
        { ...authority, sessionCreatedAt: authority.sessionCreatedAt + 1 },
      ],
      ['missing session expiry', { ...authority, sessionExpiresAt: undefined }],
      ['forged session expiry', { ...authority, sessionExpiresAt: authority.sessionExpiresAt + 1 }],
      ['missing session proof', { ...authority, sessionCsrfProof: undefined }],
      ['null session proof', { ...authority, sessionCsrfProof: null }],
      ['empty session proof', { ...authority, sessionCsrfProof: '' }],
      ['short session proof', { ...authority, sessionCsrfProof: 'short' }],
      ['invalid session proof alphabet', { ...authority, sessionCsrfProof: '!'.repeat(43) }],
      ['long session proof', { ...authority, sessionCsrfProof: 'A'.repeat(44) }],
      ['raw CSRF secret as proof', { ...authority, sessionCsrfProof: screen.session.csrf }],
      ['forged well-formed session proof', { ...authority, sessionCsrfProof: alternateProof }],
      ['scanner-domain session proof', { ...authority, sessionCsrfProof: wrongDomain }],
      ['missing platform roles', { ...authority, sessionRoles: undefined }],
      ['malformed platform roles', { ...authority, sessionRoles: ['user', 'unknown'] }],
      ['missing authentication method', { ...authority, amr: undefined }],
      ['malformed authentication method', { ...authority, amr: 'unknown' }],
      ['missing capability', { ...authority, capability: undefined }],
      ['management capability', { ...authority, capability: 'scanning:manage' }],
      ['operation capability', { ...authority, capability: 'passes:operate' }],
      ['unknown capability', { ...authority, capability: 'other:read' }],
    ];
    for (const [label, snapshot] of forged) {
      const attachment = replaceAuthority(screen, snapshot);
      expect((await liveRecipient(kit.ctx, attachment)) === null, label).toBe(true);
      expect(
        JSON.stringify(await hub().snapshot(attachment)) === '{"rows":[],"cursor":null}',
        label,
      ).toBe(true);
    }
    // A top-level-only change is separately rejected as an actor/envelope mismatch.
    expect(
      await liveRecipient(kit.ctx, {
        ...screen.attachment,
        admin: {
          ...screen.attachment.admin!,
          tenantAuthority: { ...authority, sessionCsrfProof: alternateProof },
        },
      }),
    ).toBeNull();
    await assertClosed(replaceAuthority(screen, undefined));
    await assertClosed(replaceAuthority(screen, { ...authority, kind: 'api_key' }));
    expect(await liveRecipient(kit.ctx, { ...screen.attachment, admin: undefined })).toBeNull();
    expect(await liveRecipient(kit.ctx, { ...screen.attachment, orgId: 'another-org' })).toBeNull();
    expect(await liveRecipient(kit.ctx, { ...screen.attachment, mode: 'test' })).toBeNull();
    expect(
      await liveRecipient(kit.ctx, {
        ...screen.attachment,
        admin: { ...screen.attachment.admin!, userId: 'another-user' },
      }),
    ).toBeNull();
    expect(
      await liveRecipient(kit.ctx, {
        ...screen.attachment,
        admin: { ...screen.attachment.admin!, sessionId: 'another-session' },
      }),
    ).toBeNull();
  });

  it('rejects a valid D1 API-key authority as a user-backed screen attachment', async () => {
    const screen = await managedScreen();
    const key = await makeApiKey(kit.fx, { orgId: kit.org.id, scopes: ['scans:read'] });
    const keyAuthority = await captureKeyAuthority(key);
    expect(await tenantPassAuthorityValid(kit.env.DB, keyAuthority, kit.clock.now())).toBe(true);
    await assertClosed(replaceAuthority(screen, keyAuthority));
  });

  it('rejects authentic snapshots from a different org, mode, user, session or capability', async () => {
    const screen = await managedScreen();
    const otherOrg = await makeOrg(kit.fx);
    await grantScanMembership(kit.fx, otherOrg.id, screen.user.id);
    const otherOrgAuthority = await sessionAuthority(screen.resolved, otherOrg.id);
    const otherModeAuthority = await sessionAuthority({ ...screen.resolved, mode: 'test' });
    const otherSession = await makeSession(kit.fx, {
      userId: screen.user.id,
      roles: ['admin', 'user'],
    });
    const otherResolved = await createSessionStore(kit.env, kit.clock).resolve(
      otherSession.cookieValue,
    );
    if (!otherResolved) throw new Error('Missing second platform session.');
    const otherSessionAuthority = await sessionAuthority(otherResolved);
    const otherUser = await makeUser(kit.fx);
    await grantScanMembership(kit.fx, kit.org.id, otherUser.id);
    const otherUserSession = await makeSession(kit.fx, {
      userId: otherUser.id,
      roles: ['admin', 'user'],
    });
    const otherUserResolved = await createSessionStore(kit.env, kit.clock).resolve(
      otherUserSession.cookieValue,
    );
    if (!otherUserResolved) throw new Error('Missing other user session.');
    const otherUserAuthority = await sessionAuthority(otherUserResolved);
    const manageAuthority = await sessionAuthority(screen.resolved, kit.org.id, 'scanning:manage');
    const operateAuthority = await sessionAuthority(screen.resolved, kit.org.id, 'passes:operate');
    for (const authority of [
      otherOrgAuthority,
      otherModeAuthority,
      otherSessionAuthority,
      otherUserAuthority,
      manageAuthority,
      operateAuthority,
    ])
      expect(await liveRecipient(kit.ctx, replaceAuthority(screen, authority))).toBeNull();
  });
});
