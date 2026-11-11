import { describe, expect, it } from 'vitest';
import { openMemberPhotoFromSnapshot } from '../passes/member-photo.ts';
import { liveRecipient } from './live-auth.ts';
import { prepareLivePhoto } from './live-photo-delivery.ts';
import { hub, kit, photoFixture } from './scan-hub-test-fixtures.ts';

describe('captured live photo authority', () => {
  it('captures the original guard actor, attachment and event before asynchronous acquisition', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const sourceProof = await hub().sourceProof(fixture.event.id);
    const grant = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
    if (!recipient?.actor.scanner || !recipient.attachment.actor.scanner || !sourceProof || !grant)
      throw new Error('Missing real live photo authority.');
    const ref = { eventId: fixture.event.id, sourceProof };
    const pending = prepareLivePhoto(
      kit.ctx,
      recipient.actor,
      recipient.attachment,
      fixture.pass.id,
      ref,
      grant,
    );
    recipient.actor.scanner.tokenHash = 'changed-after-call';
    recipient.actor.scanner.updatedAt++;
    recipient.attachment.actor.scanner.tokenHash = 'changed-attachment';
    recipient.attachment.scannerId = 'different-screen';
    ref.eventId = 'different-event';
    ref.sourceProof = 'different-proof';
    const prepared = await pending;
    if (!prepared) throw new Error('Original captured authority was not retained.');
    const response = await openMemberPhotoFromSnapshot(kit.ctx, prepared.photo);
    expect(await prepared.recheck()).toBe(true);
    expect(response.status).toBe(200);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('rejects an actor substituted for the original attachment or a mismatched event proof', async () => {
    const fixture = await photoFixture();
    const recipient = await liveRecipient(kit.ctx, fixture.monitor.attachment);
    const sourceProof = await hub().sourceProof(fixture.event.id);
    const grant = new URL(fixture.path, 'https://wallet.test').searchParams.get('g');
    const scanner = recipient?.actor.scanner;
    if (!recipient || !scanner || !sourceProof || !grant)
      throw new Error('Missing real live authority.');
    const ref = { eventId: fixture.event.id, sourceProof };
    const actor = recipient.actor;
    const mismatches = [
      { ...actor, orgId: 'other-org' },
      { ...actor, mode: 'test' as const },
      { ...actor, scanner: { ...scanner, tokenHash: 'different-token-hash' } },
      { ...actor, scanner: { ...scanner, updatedAt: scanner.updatedAt + 1 } },
      { ...actor, scanner: { ...scanner, id: 'different-screen' } },
    ];
    for (const other of mismatches)
      expect(
        await prepareLivePhoto(kit.ctx, other, recipient.attachment, fixture.pass.id, ref, grant),
      ).toBeNull();
    for (const invalid of [
      { ...ref, eventId: 'different-event' },
      { ...ref, sourceProof: '' },
      { ...ref, sourceProof: `${sourceProof.slice(0, -1)}!` },
    ])
      expect(
        await prepareLivePhoto(
          kit.ctx,
          actor,
          recipient.attachment,
          fixture.pass.id,
          invalid,
          grant,
        ),
      ).toBeNull();
  });
});
