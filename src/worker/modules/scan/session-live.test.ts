import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { scanHub } from './live.ts';
import { openLiveAttachment, sealLiveAttachment } from './live-attachment.ts';
import { liveRecipient } from './live-auth.ts';
import { liveRowFor } from './live-render.ts';
import { captureObservedScanningSession } from './scanning-workspace-observation.ts';
import { type SessionLiveFixtures, sessionLiveFixtures } from './session-live-test-fixtures.ts';

let fixtures: SessionLiveFixtures;
beforeAll(async () => {
  fixtures = await sessionLiveFixtures();
});

describe('session display authorization', () => {
  it('follows new devices in its own session and excludes another session', async () => {
    const { kit, parent, child, pairedAttachment, row, withSourceProof } = fixtures;
    const a = await parent('Display session A');
    const b = await parent('Display session B');
    const monitor = await pairedAttachment(a.id, 'A desk', 'desk');
    const customer = await pairedAttachment(a.id, 'A visitor', 'customer');
    // The screen is already connected when these scanners are enrolled.
    const sourceA = await child(a.id, 'A scanner');
    const sourceB = await child(b.id, 'B scanner');
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    for (const source of [sourceA, sourceB]) {
      const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
        code: source.pairing?.code,
      });
      expect(paired.status).toBe(200);
      expect(
        await hub.publish({
          orgId: kit.org.id,
          mode: 'live',
          row: await withSourceProof(row(source.id)),
        }),
      ).toBe(true);
    }
    expect((await hub.snapshot(monitor)).rows).toMatchObject([
      { scannerId: sourceA.id, holder: null, passId: null },
    ]);
    expect((await hub.snapshot(monitor)).rows).toHaveLength(1);
    const recipient = await liveRecipient(kit.ctx, customer);
    if (!recipient) throw new Error('Missing customer recipient.');
    expect(
      await liveRowFor(kit.ctx, recipient, await withSourceProof(row(sourceA.id))),
    ).toMatchObject({
      scannerId: sourceA.id,
      holder: null,
      passId: null,
      photoUrl: null,
      scannerName: '',
      label: 'Checked in',
    });
    expect(await liveRowFor(kit.ctx, recipient, await withSourceProof(row(sourceB.id)))).toBeNull();
    expect((await hub.snapshot(customer)).rows).toEqual([]);
  });

  it('restores the original paired workspace after encrypted transport and rejects crossed authority', async () => {
    const { kit, parent, pairedAttachment } = fixtures;
    const session = await parent('Hibernating display');
    const attachment = await pairedAttachment(session.id, 'Hibernating desk', 'desk');
    const otherSession = await parent('Other display');
    const other = await pairedAttachment(otherSession.id, 'Other desk', 'desk');
    const foreignOrg = await makeOrg(kit.fx);
    if (!attachment.scannerCsrfProof || !other.scannerCsrfProof)
      throw new Error('Missing paired scanner proofs.');
    expect(attachment.actor.scanner?.csrfSecret).toBeNull();
    expect(attachment.actor.scanningSession?.id).toBe(session.id);
    expect(attachment.observation).not.toBeNull();
    expect(other.scannerCsrfProof).not.toBe(attachment.scannerCsrfProof);
    const sealed = await sealLiveAttachment(kit.env, attachment);
    expect(sealed).not.toContain(attachment.tokenHash);
    expect(sealed).not.toContain(attachment.scannerCsrfProof);
    const resumed = await openLiveAttachment(kit.env, sealed);
    if (!resumed) throw new Error('Missing resumed live attachment.');
    expect(resumed.actor.scanner?.csrfSecret).toBeNull();
    expect(resumed.actor.scannerCsrfProof).toBe(attachment.scannerCsrfProof);
    const recipient = await liveRecipient(kit.ctx, resumed);
    if (!recipient) throw new Error('Resumed paired display was rejected.');
    expect(captureObservedScanningSession(recipient.actor)).toEqual(attachment.observation);
    for (const crossed of [
      { ...resumed, orgId: foreignOrg.id },
      { ...resumed, mode: 'test' as const },
      { ...resumed, scannerId: other.scannerId },
      { ...resumed, session: other.session },
      { ...resumed, scannerCsrfProof: other.scannerCsrfProof },
    ]) {
      expect(await liveRecipient(kit.ctx, crossed)).toBeNull();
    }
  });
});

it('does not deliver to a screen whose pinned event became invalid', async () => {
  const { kit, parent, pairedAttachment } = fixtures;
  const session = await parent('Invalid pinned display');
  const attachment = await pairedAttachment(session.id, 'Invalid customer', 'customer');
  const templateId = await kit.scanTemplate('Invalid display template', {
    actions: [{ id: 'check_in', label: 'Check in', kind: 'check_in' }],
  });
  const event = await kit.event({ templateIds: [templateId] });
  await run(kit.env.DB, 'UPDATE scan_events SET archived_at=? WHERE id=?', [
    kit.clock.now(),
    event.id,
  ]);
  await run(kit.env.DB, 'UPDATE scanners SET event_id=? WHERE id=?', [
    event.id,
    attachment.scannerId,
  ]);
  expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
});
