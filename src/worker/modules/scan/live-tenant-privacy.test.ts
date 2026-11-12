import { beforeAll, describe, expect, it } from 'vitest';
import { ScanLiveSnapshotSchema } from '../../../shared/contracts/scan-setups.ts';
import { run } from '../../platform/db.ts';
import { createLogger } from '../../platform/log.ts';
import { putMemberPhoto } from '../passes/member-photo.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { tenantScanRole } from './actor.ts';
import { managedAdminActor } from './admin-setup.ts';
import { liveRecipient } from './live-auth.ts';
import { livePassSnapshot, openLiveSourceProof, sealLiveSourceProof } from './live-provenance.ts';
import { liveRowFor } from './live-render.ts';
import { liveTenantFixture, ORIGIN } from './live-tenant-test-fixtures.ts';
import { candidateById } from './repo-lookup.ts';
import { joinAdminScanningSession } from './scanning-devices.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { proofedScanActor, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, pairDevice, provenRow, hub, upgrade } = fixture;
let kit: ScanKit;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  ({ kit, credentialKeysetCommitment } = await fixture.setup());
});

describe('live tenant privacy and delivery', () => {
  it('keeps both CSRF secrets out of decrypted proofs, live JSON, photo URLs and logs', async () => {
    const screen = await managedScreen({ scoped: true, withSource: true });
    if (!screen.templateId || !screen.source?.actor.scanner)
      throw new Error('Missing scoped live fixture.');
    const source = screen.source;
    const scanner = source.actor.scanner!;
    const scannerSecret = source.csrfSecret;
    const scannerProof = source.actor.scannerCsrfProof;
    if (!scannerProof) throw new Error('Missing scanner proof.');
    const entry = await provenRow(source.actor);
    await expect(
      sealLiveSourceProof(kit.env, {
        actor: { ...source.actor, scanner: { ...scanner, csrfSecret: scannerSecret } },
        credentialContext: {
          credentialKeysetCommitment,
          credentialTombstoneRefs: [],
          otherModeCredentialTombstoneRefs: [],
        },
        eventId: entry.id,
        passId: null,
        passSnapshot: null,
        at: entry.at,
      }),
    ).rejects.toThrow();
    const opened = await openLiveSourceProof(kit.env, entry.sourceProof);
    if (!opened) throw new Error('Missing paired source proof.');
    expect(opened.actor.scanner?.csrfSecret === null).toBe(true);
    expect(opened.actor.scannerCsrfProof === source.actor.scannerCsrfProof).toBe(true);
    expect(JSON.stringify(opened).includes(scannerSecret)).toBe(false);
    expect(JSON.stringify(opened).includes(screen.session.csrf)).toBe(false);
    expect(JSON.stringify(entry).includes(scannerSecret)).toBe(false);

    const joined = await joinAdminScanningSession(
      kit.ctx,
      screen.user.id,
      'live',
      { sessionId: screen.workspace.id, deviceKey: '44444444-4444-4444-8444-444444444444' },
      ORIGIN,
      screen.management,
    );
    const admin = await managedAdminActor(
      kit.ctx,
      screen.resolved,
      'live',
      kit.org.id,
      joined.setupId,
    );
    admin.platformSessionId = screen.resolved.sessionId;
    admin.tenantAuthority = screen.authority;
    admin.role = tenantScanRole(screen.authority);
    await bindScanningSession(kit.ctx, admin);
    const adminEntry = await provenRow(await proofedScanActor(kit.ctx, admin));
    const adminProof = await openLiveSourceProof(kit.env, adminEntry.sourceProof);
    if (!adminProof) throw new Error('Missing user source proof.');
    expect(
      adminProof.actor.tenantAuthority?.sessionCsrfProof === screen.authority.sessionCsrfProof,
    ).toBe(true);
    expect(JSON.stringify(adminProof).includes(screen.session.csrf)).toBe(false);
    expect(JSON.stringify(adminProof).includes(scannerSecret)).toBe(false);

    const pass = await kit.scanPass(screen.templateId);
    const png = btoa(String.fromCharCode(...makePng(270, 270)));
    await putMemberPhoto(
      kit.ctx,
      { type: 'system', id: null },
      pass.id,
      { png, includeInPass: false },
      null,
    );
    const candidate = await candidateById(kit.env.DB, kit.org.id, pass.id);
    if (!candidate) throw new Error('Missing live pass candidate.');
    const photoEntry = {
      ...entry,
      passId: pass.id,
      sourceProof: await sealLiveSourceProof(kit.env, {
        actor: source.actor,
        credentialContext: {
          credentialKeysetCommitment: candidate.credentialKeysetCommitment,
          credentialTombstoneRefs: candidate.credentialTombstoneRefs,
          otherModeCredentialTombstoneRefs: candidate.otherModeCredentialTombstoneRefs,
        },
        eventId: entry.id,
        passId: pass.id,
        passSnapshot: await livePassSnapshot(kit.env, candidate),
        at: entry.at,
      }),
    };
    const recipient = await liveRecipient(kit.ctx, screen.attachment);
    if (!recipient) throw new Error('Missing live recipient.');
    const projection = await liveRowFor(kit.ctx, recipient, photoEntry);
    if (!projection?.photoUrl) throw new Error('Missing live photo URL.');
    const url = new URL(projection.photoUrl, ORIGIN);
    expect(url.searchParams.has('g')).toBe(true);
    expect(url.toString().includes(scannerSecret)).toBe(false);
    expect(url.toString().includes(screen.session.csrf)).toBe(false);
    expect(url.toString().includes(scannerProof)).toBe(false);
    expect(url.toString().includes(screen.authority.sessionCsrfProof)).toBe(false);
    expect(url.toString()).not.toContain(screen.resolved.sessionId);
    expect(JSON.stringify(projection).includes(scannerSecret)).toBe(false);
    expect(JSON.stringify(projection).includes(screen.session.csrf)).toBe(false);
    expect(JSON.stringify(projection).includes(scannerProof)).toBe(false);
    expect(JSON.stringify(projection).includes(screen.authority.sessionCsrfProof)).toBe(false);
    expect(JSON.stringify(projection).includes(photoEntry.sourceProof)).toBe(false);
    expect(JSON.stringify(projection)).not.toContain(screen.resolved.sessionId);
    expect(await hub().publish({ orgId: kit.org.id, mode: 'live', row: photoEntry })).toBe(true);
    const snapshot = JSON.stringify(await hub().snapshot(screen.attachment));
    expect(snapshot.includes(scannerSecret)).toBe(false);
    expect(snapshot.includes(screen.session.csrf)).toBe(false);
    expect(snapshot.includes(scannerProof)).toBe(false);
    expect(snapshot.includes(screen.authority.sessionCsrfProof)).toBe(false);
    expect(snapshot.includes(photoEntry.sourceProof)).toBe(false);
    expect(snapshot).not.toContain(screen.resolved.sessionId);

    const lines: string[] = [];
    const log = createLogger(
      {},
      {
        level: 'debug',
        sink: (line) => {
          lines.push(line);
        },
      },
    );
    await run(kit.env.DB, "UPDATE scanners SET settings='{}' WHERE id=?", [screen.device.id]);
    expect(await liveRecipient({ ...kit.ctx, log }, screen.attachment)).toBeNull();
    await managedAdminActor(
      { ...kit.ctx, log },
      screen.resolved,
      'live',
      kit.org.id,
      screen.device.id,
    );
    expect(lines.some((line) => line.includes('scan.settings_invalid'))).toBe(true);
    expect(
      lines.some((line) => line.includes(scannerSecret) || line.includes(screen.session.csrf)),
    ).toBe(false);
    expect(
      lines.some(
        (line) => line.includes(scannerProof) || line.includes(screen.authority.sessionCsrfProof),
      ),
    ).toBe(false);
    expect(lines.some((line) => line.includes(screen.resolved.sessionId))).toBe(false);
  });

  it('closes an open socket on the next delivery and exposes no replay after membership revocation', async () => {
    const screen = await managedScreen();
    const source = await pairDevice(screen, 'phone');
    const entry = await provenRow(source.actor);
    expect(await hub().publish({ orgId: kit.org.id, mode: 'live', row: entry })).toBe(true);
    const before = await hub().snapshot(screen.attachment);
    expect(
      before.rows.length === 1 &&
        before.rows[0]?.scannerId === source.device.id &&
        before.rows[0].holder === null &&
        before.rows[0].passId === null,
    ).toBe(true);
    const response = await upgrade(screen.attachment);
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error('Missing live socket.');
    socket.accept();
    try {
      const initial = await new Promise<string>((resolve) =>
        socket.addEventListener('message', (event) => resolve(String(event.data)), { once: true }),
      );
      const scannerSecret = source.csrfSecret;
      if (!scannerSecret) throw new Error('Missing scanner credential.');
      expect(initial.includes(screen.session.csrf)).toBe(false);
      expect(initial.includes(scannerSecret)).toBe(false);
      expect(initial.includes(screen.authority.sessionCsrfProof)).toBe(false);
      expect(initial.includes(screen.resolved.sessionId)).toBe(false);
      expect(initial.includes(screen.membershipId)).toBe(false);
      const initialSnapshot = ScanLiveSnapshotSchema.parse(JSON.parse(initial));
      expect(initialSnapshot.rows.length === 1).toBe(true);
      const messages: string[] = [];
      socket.addEventListener('message', (event) => messages.push(String(event.data)));
      const closed = new Promise<CloseEvent>((resolve) =>
        socket.addEventListener('close', resolve, { once: true }),
      );
      await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
        kit.clock.now(),
        screen.membershipId,
      ]);
      expect(
        JSON.stringify(await hub().snapshot(screen.attachment)) === '{"rows":[],"cursor":null}',
      ).toBe(true);
      const next = await provenRow(source.actor);
      expect(await hub().publish({ orgId: kit.org.id, mode: 'live', row: next })).toBe(true);
      const close = await closed;
      expect(close.code).toBeGreaterThanOrEqual(4000);
      expect(close.reason.includes(screen.resolved.sessionId)).toBe(false);
      expect(close.reason.includes(screen.membershipId)).toBe(false);
      expect(close.reason.includes(screen.session.csrf)).toBe(false);
      expect(close.reason.includes(scannerSecret)).toBe(false);
      expect(messages.length === 0).toBe(true);
      const refused = await upgrade(screen.attachment);
      expect(refused.status).toBe(401);
      expect((await refused.text()) === '').toBe(true);
    } finally {
      socket.close(1000);
    }
  });
});
