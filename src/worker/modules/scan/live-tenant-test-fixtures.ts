import type { OpenAPIHono } from '@hono/zod-openapi';
import { expect } from 'vitest';
import { makeSession, makeUser, type SessionFixture } from '../../../../test/helpers/index.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { createApp } from '../../app.ts';
import { denyAllStores, type ScannerAuth, type SessionAuth } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import {
  captureScanTenantAuthority,
  type ScanActor,
  type ScanTenantAuthority,
  scannerActor,
  tenantScanRole,
  withRole,
} from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { createScannerStore } from './auth-store.ts';
import { liveAttachment, scanHub } from './live.ts';
import { sealLiveAttachment } from './live-attachment.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { sealLiveSourceProof } from './live-provenance.ts';
import { asDeskDisplay } from './live-screen-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { revokeLiveTenantFixtureMembership } from './repo-live-tenant-db-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import {
  createScanningDevice,
  joinAdminScanningSession,
  updateScanningDevice,
} from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { grantScanMembership, proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
type TenantRole = 'org_admin' | 'pass_operator' | 'read_only';

interface PairedDevice {
  device: { id: string };
  auth: ScannerAuth;
  actor: ScanActor;
  csrfSecret: string;
}

interface ManagedScreen {
  user: { id: string };
  membershipId: string;
  session: SessionFixture;
  resolved: SessionAuth;
  management: TenantPassWrite;
  workspace: { id: string };
  device: { id: string };
  templateId: string | null;
  authority: ScanTenantAuthority;
  actor: ScanActor;
  attachment: LiveAttachment;
  source: PairedDevice | null;
}

export function liveTenantFixture() {
  let kit: ScanKit;
  let app: OpenAPIHono<AppBindings>;
  let credentialKeysetCommitment: string;
  async function setup() {
    kit = await setupScanKit();
    credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
    app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(kit.env, kit.clock),
        scanners: createScannerStore(kit.env, kit.clock),
      },
      clock: kit.clock,
    });
    return { kit, app, credentialKeysetCommitment };
  }

  async function sessionAuthority(
    auth: SessionAuth,
    orgId = kit.org.id,
    capability: 'scanning:read' | 'scanning:manage' | 'passes:operate' = 'scanning:read',
  ): Promise<ScanTenantAuthority> {
    const authority = await tenantAuthorityOf(kit.ctx, auth, orgId, capability);
    if (authority.kind !== 'session') throw new Error('Expected tenant session authority.');
    const captured = await captureScanTenantAuthority(kit.ctx, auth, authority);
    if (!captured) throw new Error('Missing captured tenant session authority.');
    return captured;
  }

  /** Create the managed screen with management authority, then capture its actual reader authority. */
  async function managedScreen(
    options: {
      role?: TenantRole;
      platformRoles?: ('admin' | 'user')[];
      scoped?: boolean;
      withSource?: boolean;
    } = {},
  ): Promise<ManagedScreen> {
    const user = await makeUser(kit.fx);
    let membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id);
    const session = await makeSession(kit.fx, {
      userId: user.id,
      roles: options.platformRoles ?? ['admin', 'user'],
    });
    const resolved = await createSessionStore(kit.env, kit.clock).resolve(session.cookieValue);
    if (!resolved) throw new Error('Missing real platform session.');
    const management = await tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:manage');
    const countAuthority = await captureConsoleSessionCountAuthority(
      kit.ctx,
      resolved,
      await tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:read'),
    );
    const templateId = options.scoped
      ? await kit.scanTemplate('Live scoped release', {
          actions: [{ id: 'entry', label: 'Check in', kind: 'check_in' }],
        })
      : null;
    const workspace = await createScanningSession(
      kit.ctx,
      user.id,
      'live',
      CreateScanningSessionSchema.parse({
        orgId: kit.org.id,
        name: `Live authority ${kit.fx.ids.token(5)}`,
        timeZone: 'UTC',
        ...(templateId ? { accepts: { templateIds: [templateId] } } : {}),
      }),
      management,
      countAuthority,
    );
    const joined = await joinAdminScanningSession(
      kit.ctx,
      user.id,
      'live',
      { sessionId: workspace.id, deviceKey: '33333333-3333-4333-8333-333333333333' },
      ORIGIN,
      management,
    );
    const device = await updateScanningDevice(
      kit.ctx,
      user.id,
      workspace.id,
      joined.setupId,
      { surface: 'desk' },
      management,
    );
    await asDeskDisplay(kit.env.DB, device.id);
    const source = options.withSource
      ? await pairDevice({ user, workspace, management }, 'phone')
      : null;
    if (options.role && options.role !== 'org_admin') {
      await revokeLiveTenantFixtureMembership(kit.env.DB, kit.clock.now(), membershipId);
      membershipId = await grantScanMembership(kit.fx, kit.org.id, user.id, [options.role]);
    }
    const authority = await sessionAuthority(resolved);
    const rawActor = await managedAdminActor(kit.ctx, resolved, 'live', kit.org.id, device.id);
    rawActor.platformSessionId = resolved.sessionId;
    rawActor.tenantAuthority = authority;
    rawActor.role = tenantScanRole(authority);
    await bindScanningSession(kit.ctx, rawActor);
    const actor = await proofedScanActor(kit.ctx, rawActor);
    const attachment = liveAttachment(kit.ctx, actor);
    if (!attachment.admin) throw new Error('Expected a user-backed live attachment.');
    return {
      user,
      membershipId,
      session,
      resolved,
      management,
      workspace,
      device,
      templateId,
      authority,
      actor,
      attachment,
      source,
    };
  }

  function replaceAuthority(screen: ManagedScreen, authority: unknown): LiveAttachment {
    if (!screen.attachment.admin) throw new Error('Expected a user-backed live attachment.');
    return {
      ...screen.attachment,
      admin: { ...screen.attachment.admin, tenantAuthority: authority as ScanTenantAuthority },
      actor: { ...screen.attachment.actor, tenantAuthority: authority as ScanTenantAuthority },
    };
  }

  /** Mint a new attachment from an actual session, guard and workspace observation. */
  async function attachmentForSession(
    screen: ManagedScreen,
    auth: SessionAuth,
  ): Promise<LiveAttachment> {
    const authority = await sessionAuthority(auth);
    const actor = await managedAdminActor(kit.ctx, auth, 'live', kit.org.id, screen.device.id);
    actor.platformSessionId = auth.sessionId;
    actor.tenantAuthority = authority;
    actor.role = tenantScanRole(authority);
    await bindScanningSession(kit.ctx, actor);
    return liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor));
  }

  async function refreshedAttachment(screen: ManagedScreen): Promise<LiveAttachment> {
    return attachmentForSession(screen, screen.resolved);
  }

  function hub() {
    return scanHub(kit.ctx, kit.org.id, 'live');
  }

  async function upgrade(attachment: LiveAttachment) {
    let token: string;
    try {
      token = await sealLiveAttachment(kit.env, attachment);
    } catch {
      // Malformed attachments cannot be sealed; the hub must also reject raw JSON.
      token = JSON.stringify(attachment);
    }
    return hub().fetch(
      new Request('https://hub.test', {
        headers: { upgrade: 'websocket', 'x-pb-live': token },
      }),
    );
  }

  async function assertClosed(attachment: LiveAttachment) {
    expect((await liveRecipient(kit.ctx, attachment)) === null).toBe(true);
    expect(JSON.stringify(await hub().snapshot(attachment)) === '{"rows":[],"cursor":null}').toBe(
      true,
    );
    const response = await upgrade(attachment);
    expect(response.status).toBe(401);
    expect((await response.text()) === '').toBe(true);
  }

  async function pairDevice(
    screen: Pick<ManagedScreen, 'user' | 'workspace' | 'management'>,
    surface: 'phone' | 'desk',
  ): Promise<PairedDevice> {
    const device = await createScanningDevice(
      kit.ctx,
      screen.user.id,
      'live',
      screen.workspace.id,
      { name: `Paired ${surface} ${kit.fx.ids.token(4)}`, surface, overrides: {} },
      ORIGIN,
      screen.management,
    );
    if (!device.pairing) throw new Error('Missing pairing code.');
    const response = await kit.post({ origin: ORIGIN }, '/pair', { code: device.pairing.code });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.match(/__Host-wallet_scan=([^;]+)/)?.[1];
    if (!cookie) throw new Error('Missing scanner cookie.');
    const auth = await createScannerStore(kit.env, kit.clock).resolve(cookie, 'cookie');
    if (!auth) throw new Error('Scanner cookie did not resolve.');
    const scanner = await getScanner(kit.env.DB, device.id);
    if (!scanner?.csrfSecret) throw new Error('Missing paired scanner credential.');
    const scope = await readScannerScope(kit.env.DB, scanner, null);
    const rawActor = scannerActor(kit.ctx, scanner, auth.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, rawActor);
    withRole(rawActor, null);
    return {
      device,
      auth,
      actor: await proofedScanActor(kit.ctx, rawActor),
      csrfSecret: scanner.csrfSecret,
    };
  }

  async function provenRow(actor: ScanActor): Promise<ScanLiveRow & { sourceProof: string }> {
    if (!actor.scanner) throw new Error('Missing live source scanner.');
    const row: ScanLiveRow = {
      id: kit.ctx.ids.token(16),
      at: kit.clock.now(),
      scannerId: actor.scanner.id,
      scannerName: 'Entry scanner',
      passId: null,
      holder: 'Private live holder',
      photoUrl: null,
      kind: 'ok',
      direction: 'in',
      label: 'Checked in',
      presented: true,
    };
    return {
      ...row,
      sourceProof: await sealLiveSourceProof(kit.env, {
        actor,
        credentialContext: {
          credentialKeysetCommitment,
          credentialTombstoneRefs: [],
          otherModeCredentialTombstoneRefs: [],
        },
        eventId: row.id,
        passId: null,
        passSnapshot: null,
        at: row.at,
      }),
    };
  }

  return {
    setup,
    sessionAuthority,
    managedScreen,
    replaceAuthority,
    attachmentForSession,
    refreshedAttachment,
    hub,
    upgrade,
    assertClosed,
    pairDevice,
    provenRow,
  };
}
