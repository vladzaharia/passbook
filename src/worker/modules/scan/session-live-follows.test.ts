import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { liveRecipient } from './live-auth.ts';
import { watches } from './live-render.ts';
import { updateScanningDevice } from './scanning-devices.ts';
import {
  pairedScreenAttachment,
  type SessionLiveFixtures,
  sessionLiveFixtures,
} from './session-live-test-fixtures.ts';

let fixtures: SessionLiveFixtures;
beforeAll(async () => {
  fixtures = await sessionLiveFixtures();
});

async function twoDoors(name: string, follows?: (doors: { a: string; b: string }) => unknown) {
  const { kit, parent, child, withSourceProof, row } = fixtures;
  const session = await parent(name);
  const a = await child(session.id, `${name} A`);
  const b = await child(session.id, `${name} B`);
  const screenDevice = await child(session.id, `${name} screen`, 'customer');
  if (follows)
    await run(kit.env.DB, 'UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
      JSON.stringify(follows({ a: a.id, b: b.id })),
      screenDevice.id,
    ]);
  const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
    code: screenDevice.pairing?.code,
  });
  const cookie = paired.headers.get('set-cookie');
  if (!cookie) throw new Error('Missing paired scanner cookie.');
  const attachment = await pairedScreenAttachment(kit, screenDevice.id, cookie);
  const recipient = await liveRecipient(kit.ctx, attachment);
  const seen = async (id: string) =>
    !!recipient && watches(recipient, await withSourceProof(row(id)));
  return { recipient, seen, a, b, session, screen: attachment.scannerId };
}

describe('customer screen follows', () => {
  it('sees every scanner in the session by default', async () => {
    const { seen, a, b } = await twoDoors('All doors');
    expect(await seen(a.id)).toBe(true);
    expect(await seen(b.id)).toBe(true);
  });

  it('sees only the scanner it follows', async () => {
    const { seen, a, b } = await twoDoors('One door', ({ a }) => ({ follows: [a] }));
    expect(await seen(a.id)).toBe(true);
    expect(await seen(b.id)).toBe(false);
  });

  it('ignores a followed scanner from another session or org, and sees nothing of it', async () => {
    const { parent, child, withSourceProof, row } = fixtures;
    const other = await parent('Other session');
    const stranger = await child(other.id, 'Stranger');
    const { recipient, seen, a } = await twoDoors('Fenced', ({ a }) => ({
      follows: [a, stranger.id, 'not-an-org-scanner'],
    }));
    expect(recipient?.watch.scannerIds).toEqual([a.id]);
    expect(await seen(a.id)).toBe(true);
    expect(!!recipient && watches(recipient, await withSourceProof(row(stranger.id)))).toBe(false);
  });

  it('rejects a follow outside the session, and on a scanner', async () => {
    const { kit, authority, parent, child } = fixtures;
    const other = await parent('Elsewhere');
    const stranger = await child(other.id, 'Elsewhere door');
    const { session, a, screen } = await twoDoors('Validated');
    await expect(
      updateScanningDevice(
        kit.ctx,
        'admin-1',
        session.id,
        screen,
        { overrides: { follows: [stranger.id] } },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'SCANNING_FOLLOWS_INVALID' });
    await expect(
      updateScanningDevice(
        kit.ctx,
        'admin-1',
        session.id,
        a.id,
        { overrides: { follows: [a.id] } },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'SCANNING_FOLLOWS_INVALID' });
    const saved = await updateScanningDevice(
      kit.ctx,
      'admin-1',
      session.id,
      screen,
      { overrides: { follows: [a.id] } },
      authority,
    );
    expect(saved.overrides).toEqual({ follows: [a.id] });
  });

  it('drops a live socket when the admin changes what the screen follows', async () => {
    const { kit, authority } = fixtures;
    const { recipient, session, a, screen } = await twoDoors('Retargeted');
    if (!recipient) throw new Error('Missing recipient.');
    await updateScanningDevice(
      kit.ctx,
      'admin-1',
      session.id,
      screen,
      { overrides: { follows: [a.id] } },
      authority,
    );
    expect(await liveRecipient(kit.ctx, recipient.attachment)).toBeNull();
  });
});
