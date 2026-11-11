import { beforeAll, describe, expect, it } from 'vitest';
import { runOne } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { scannerActor, scanScannerCsrfProof, scanSessionCsrfProof, withRole } from './actor.ts';
import { liveAttachment } from './live.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { liveTenantFixture } from './live-tenant-test-fixtures.ts';
import { getScanner } from './repo-device.ts';
import { raceFinalFence } from './repo-live-tenant-db-test-fixtures.ts';
import { readScannerScope } from './repo-scope.ts';
import { bindScanningSession } from './scanning-workspace.ts';
import { proofedScanActor, type ScanKit } from './test-kit.ts';

const fixture = liveTenantFixture();
const { managedScreen, pairDevice, assertClosed, hub } = fixture;
let kit: ScanKit;
let credentialKeysetCommitment: string;
beforeAll(async () => {
  ({ kit, credentialKeysetCommitment } = await fixture.setup());
});

describe('paired live scanner authority', () => {
  it('keeps the paired scanner-cookie screen path independent of tenant sessions', async () => {
    const screen = await managedScreen();
    const paired = await pairDevice(screen, 'desk');
    expect(
      paired.auth.kind === 'scanner' &&
        paired.auth.scannerId === paired.device.id &&
        paired.auth.transport === 'cookie',
    ).toBe(true);
    const attachment = liveAttachment(kit.ctx, paired.actor);
    expect(attachment.credentialKeysetCommitment === credentialKeysetCommitment).toBe(true);
    const scannerSecret = paired.csrfSecret;
    if (!scannerSecret) throw new Error('Missing paired scanner credential.');
    expect(
      attachment.scannerCsrfProof ===
        (await scanScannerCsrfProof(kit.env, paired.device.id, scannerSecret)),
    ).toBe(true);
    expect(JSON.stringify(attachment).includes(scannerSecret)).toBe(false);
    expect(JSON.stringify(attachment).includes(screen.session.csrf)).toBe(false);
    expect(attachment.admin).toBeUndefined();
    const recipient = await liveRecipient(kit.ctx, attachment);
    expect(
      recipient?.actor.principal === 'scanner' &&
        recipient.actor.actor.type === 'scanner' &&
        recipient.actor.actor.id === paired.device.id,
    ).toBe(true);
    await run(kit.env.DB, 'UPDATE org_memberships SET revoked_at=? WHERE id=?', [
      kit.clock.now(),
      screen.membershipId,
    ]);
    expect(await liveRecipient(kit.ctx, screen.attachment)).toBeNull();
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
  });

  it('rejects missing, malformed or forged paired scanner proofs', async () => {
    const screen = await managedScreen();
    const paired = await pairDevice(screen, 'desk');
    const secret = paired.csrfSecret;
    if (!secret) throw new Error('Missing paired scanner credential.');
    const attachment = liveAttachment(kit.ctx, paired.actor);
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    const missing = { ...attachment };
    Reflect.deleteProperty(missing, 'scannerCsrfProof');
    const forged = await scanScannerCsrfProof(kit.env, paired.device.id, kit.fx.ids.token());
    const foreign = await scanScannerCsrfProof(kit.env, 'another-scanner', secret);
    const wrongDomain = await scanSessionCsrfProof(kit.env, paired.device.id, secret);
    expect(await liveRecipient(kit.ctx, { ...attachment, scannerCsrfProof: forged })).toBeNull();
    for (const proof of [
      undefined,
      null,
      '',
      'short',
      '!'.repeat(43),
      'A'.repeat(44),
      secret,
      forged,
      foreign,
      wrongDomain,
    ]) {
      const altered = {
        ...attachment,
        scannerCsrfProof: proof,
        actor: { ...attachment.actor, scannerCsrfProof: proof },
      } as LiveAttachment;
      expect((await liveRecipient(kit.ctx, altered)) === null).toBe(true);
      expect(JSON.stringify(await hub().snapshot(altered)) === '{"rows":[],"cursor":null}').toBe(
        true,
      );
    }
    await assertClosed(missing);
  });

  it('rejects paired scanner credential replacement during the final SELECT', async () => {
    const screen = await managedScreen();
    const paired = await pairDevice(screen, 'desk');
    const attachment = liveAttachment(kit.ctx, paired.actor);
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    const originalSecret = paired.csrfSecret;
    if (!originalSecret) throw new Error('Missing scanner credential.');
    const replacement = kit.fx.ids.token();
    await expect(
      run(kit.env.DB, 'UPDATE scanners SET updated_at=updated_at-1 WHERE id=?', [paired.device.id]),
    ).rejects.toThrow();
    await expect(
      run(kit.env.DB, 'UPDATE scanners SET csrf_secret=? WHERE id=?', [
        replacement,
        paired.device.id,
      ]),
    ).rejects.toThrow();
    const race = raceFinalFence(kit, () =>
      run(kit.env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
        replacement,
        paired.device.id,
      ]),
    );
    expect((await liveRecipient(race.ctx, attachment)) === null).toBe(true);
    expect(race.reached()).toBe(true);
    expect(
      /csrf_secret\s*=\s*\?\s*\/\*\s*scan-ephemeral-csrf:recipient:scanner\s*\*\//.test(
        race.statement(),
      ),
    ).toBe(true);
    expect(race.statement().includes(originalSecret)).toBe(false);
    expect(race.bound().some((value) => value === originalSecret)).toBe(true);
    expect(
      race
        .bound()
        .some(
          (value) =>
            typeof value === 'string' &&
            /^[[{]/.test(value.trim()) &&
            value.includes(originalSecret),
        ),
    ).toBe(false);
    await assertClosed(attachment);
    const scanner = await getScanner(kit.env.DB, paired.device.id);
    if (!scanner?.csrfSecret) throw new Error('Missing replacement scanner credential.');
    const scope = await readScannerScope(kit.env.DB, scanner, null);
    const actor = scannerActor(kit.ctx, scanner, scanner.mode, 'cookie', scope);
    await bindScanningSession(kit.ctx, actor);
    withRole(actor, null);
    const proofed = await proofedScanActor(kit.ctx, actor);
    const fresh = liveAttachment(kit.ctx, proofed);
    expect(await liveRecipient(kit.ctx, fresh)).not.toBeNull();
    expect(JSON.stringify(fresh).includes(replacement)).toBe(false);
    await run(kit.env.DB, 'UPDATE scanners SET csrf_secret=?,updated_at=updated_at+1 WHERE id=?', [
      originalSecret,
      paired.device.id,
    ]);
    expect((await liveRecipient(kit.ctx, attachment)) === null).toBe(true);
    expect((await liveRecipient(kit.ctx, fresh)) === null).toBe(true);
    const restored = await getScanner(kit.env.DB, paired.device.id);
    if (!restored?.csrfSecret) throw new Error('Missing restored scanner credential.');
    const restoredScope = await readScannerScope(kit.env.DB, restored, null);
    const restoredActor = scannerActor(kit.ctx, restored, restored.mode, 'cookie', restoredScope);
    await bindScanningSession(kit.ctx, restoredActor);
    withRole(restoredActor, null);
    const proofedRestored = await proofedScanActor(kit.ctx, restoredActor);
    expect(await liveRecipient(kit.ctx, liveAttachment(kit.ctx, proofedRestored))).not.toBeNull();
  });

  it('keeps deleted paired scanner identities retired for live screens', async () => {
    const screen = await managedScreen();
    const paired = await pairDevice(screen, 'desk');
    const attachment = liveAttachment(kit.ctx, paired.actor);
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    await runOne(kit.env.DB, 'DELETE FROM scanners WHERE id=?', [paired.device.id]);
    await expect(
      run(
        kit.env.DB,
        `INSERT OR REPLACE INTO scanners
      (id,org_id,mode,kind,device_role,name,settings,time_zone,created_at,updated_at)
      VALUES (?,?,'live','device','monitor',?,'{}','UTC',?,?)`,
        [
          paired.device.id,
          kit.org.id,
          `retired-${paired.device.id}`,
          kit.clock.now(),
          kit.clock.now(),
        ],
      ),
    ).rejects.toThrow();
    await assertClosed(attachment);
    const fresh = await pairDevice(screen, 'desk');
    expect(fresh.device.id).not.toBe(paired.device.id);
    expect(await liveRecipient(kit.ctx, liveAttachment(kit.ctx, fresh.actor))).not.toBeNull();
  });
});
