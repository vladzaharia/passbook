import { expect } from 'vitest';
import { makeSession } from '../../../../test/helpers/index.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { captureScanTenantAuthority, scannerActor, tenantScanRole, withRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { createScannerStore, resolvedRowOf } from './auth-store.ts';
import { liveAttachment } from './live.ts';
import type { LiveAttachment } from './live-auth.ts';
import { type InternalLiveRow, livePassSnapshot, sealLiveSourceProof } from './live-provenance.ts';
import { getScanner } from './repo-device.ts';
import { candidateById } from './repo-lookup.ts';
import { readScannerScope } from './repo-scope.ts';
import { createScanningDevice } from './scanning-devices.ts';
import { captureConsoleSessionCountAuthority } from './scanning-session-dto.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { boundStaff } from './staff-binding.ts';
import { proofedScanActor, type ScanKit, setupScanKit } from './test-kit.ts';

/** Capture the same paired scanner, CSRF proof and workspace as the route guard. */
export async function pairedScreenAttachment(kit: ScanKit, scannerId: string, cookie: string) {
  const token = cookie.match(/__Host-wallet_scan=([^;]+)/)?.[1];
  if (!token) throw new Error('Missing paired scanner cookie.');
  const auth = await createScannerStore(kit.env, kit.clock).resolve(token, 'cookie');
  if (!auth || auth.scannerId !== scannerId || !auth.csrfSecret)
    throw new Error('Paired scanner cookie did not resolve.');
  const scanner = resolvedRowOf(auth) ?? (await getScanner(kit.env.DB, scannerId));
  if (
    !scanner?.tokenHash ||
    !scanner.expiresAt ||
    scanner.csrfSecret !== auth.csrfSecret ||
    scanner.orgId !== kit.org.id ||
    scanner.orgId !== auth.orgId ||
    scanner.mode !== auth.mode ||
    scanner.kind !== auth.scannerKind ||
    scanner.deviceRole !== auth.deviceRole
  )
    throw new Error('Missing paired screen credentials.');
  const scope = await readScannerScope(kit.env.DB, scanner, scanner.staffId);
  const actor = scannerActor(kit.ctx, scanner, auth.mode, auth.transport, scope);
  const staff = await boundStaff(kit.ctx, scanner, scope.staff);
  withRole(actor, staff);
  await bindScanningSession(kit.ctx, actor);
  if (!actor.scanningSession) throw new Error('Missing paired scanning workspace.');
  withRole(actor, actor.settings.staffSignIn ? staff : null);
  return liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor));
}

/** Capture a managed screen from its real platform session and tenant membership. */
export async function managedScreenAttachment(kit: ScanKit, session: SessionAuth, setupId: string) {
  const read = await tenantAuthorityOf(kit.ctx, session, kit.org.id, 'scanning:read');
  if (read.kind !== 'session') throw new Error('Expected tenant session authority.');
  const tenantAuthority = await captureScanTenantAuthority(kit.ctx, session, read);
  const actor = await managedAdminActor(kit.ctx, session, 'live', kit.org.id, setupId);
  actor.platformSessionId = session.sessionId;
  actor.tenantAuthority = tenantAuthority;
  actor.role = tenantScanRole(tenantAuthority);
  await bindScanningSession(kit.ctx, actor);
  if (!actor.scanningSession) throw new Error('Missing managed scanning workspace.');
  return {
    attachment: liveAttachment(kit.ctx, await proofedScanActor(kit.ctx, actor)),
    tenantAuthority,
  };
}

export interface SessionLiveFixtures {
  kit: ScanKit;
  authority: TenantPassWrite;
  parent: (name: string) => Promise<{ id: string }>;
  child: (
    sessionId: string,
    name: string,
    surface?: 'phone' | 'desk' | 'customer',
  ) => Promise<{ id: string; pairing: { code: string } | null }>;
  pairedAttachment: (
    sessionId: string,
    name: string,
    role: 'desk' | 'customer',
  ) => Promise<LiveAttachment>;
  row: (scannerId: string) => ScanLiveRow;
  withSourceProof: (entry: ScanLiveRow) => Promise<InternalLiveRow>;
}

export async function sessionLiveFixtures(): Promise<SessionLiveFixtures> {
  const kit = await setupScanKit();
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(kit.env.DB, kit.env);
  const fixture = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
  const auth = await createSessionStore(kit.env, kit.clock).resolve(fixture.cookieValue);
  if (!auth) throw new Error('Missing admin session.');
  const authority = await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:manage');
  const countAuthority = await captureConsoleSessionCountAuthority(
    kit.ctx,
    auth,
    await tenantAuthorityOf(kit.ctx, auth, kit.org.id, 'scanning:read'),
  );
  const parent = (name: string) =>
    createScanningSession(
      kit.ctx,
      'admin-1',
      'live',
      CreateScanningSessionSchema.parse({ orgId: kit.org.id, name, timeZone: 'UTC' }),
      authority,
      countAuthority,
    );
  const child = (
    sessionId: string,
    name: string,
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
  async function pairedAttachment(sessionId: string, name: string, role: 'desk' | 'customer') {
    const device = await child(sessionId, name, role);
    const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
      code: device.pairing?.code,
    });
    expect(paired.status).toBe(200);
    const cookie = paired.headers.get('set-cookie');
    if (!cookie) throw new Error('Missing paired scanner cookie.');
    return pairedScreenAttachment(kit, device.id, cookie);
  }
  function row(scannerId: string): ScanLiveRow {
    return {
      id: kit.ctx.ids.token(16),
      at: kit.clock.now(),
      scannerId,
      scannerName: 'Entry scanner',
      passId: null,
      holder: 'Private name',
      photoUrl: null,
      kind: 'ok',
      direction: 'in',
      label: 'Checked in',
      presented: true,
    };
  }
  async function withSourceProof(entry: ScanLiveRow) {
    const scanner = await getScanner(kit.env.DB, entry.scannerId);
    if (!scanner) throw new Error('Missing source scanner.');
    const scope = await readScannerScope(kit.env.DB, scanner, null);
    const actor = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, actor);
    withRole(actor, null);
    const safeActor = await proofedScanActor(kit.ctx, actor);
    const candidate = entry.passId
      ? await candidateById(kit.env.DB, scanner.orgId, entry.passId)
      : null;
    if (entry.passId && !candidate) throw new Error('Missing source pass.');
    const credentialContext = candidate
      ? {
          credentialKeysetCommitment: candidate.credentialKeysetCommitment,
          credentialTombstoneRefs: candidate.credentialTombstoneRefs,
          otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
        }
      : {
          credentialKeysetCommitment,
          credentialTombstoneRefs: [],
          otherModeCredentialTombstoneRefs: [],
        };
    if (credentialContext.credentialKeysetCommitment !== safeActor.credentialKeysetCommitment)
      throw new Error('Source credential keyset changed.');
    return {
      ...entry,
      sourceProof: await sealLiveSourceProof(kit.env, {
        actor: safeActor,
        credentialContext,
        eventId: entry.id,
        passId: entry.passId,
        passSnapshot: candidate ? await livePassSnapshot(kit.env, candidate) : null,
        at: entry.at,
      }),
    };
  }
  return { kit, authority, parent, child, pairedAttachment, row, withSourceProof };
}
