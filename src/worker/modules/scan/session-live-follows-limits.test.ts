import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { liveRecipient } from './live-auth.ts';
import { revokeScanner } from './scanning-device-revocation.ts';
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

/** A session of `count` scan devices and one customer screen following `pick` of them. */
async function screenOf(name: string, count: number, pick?: (ids: string[]) => string[]) {
  const { kit, parent, child } = fixtures;
  const session = await parent(name);
  const doors: string[] = [];
  for (let i = 0; i < count; i++) doors.push((await child(session.id, `${name} ${i}`)).id);
  const screen = await child(session.id, `${name} screen`, 'customer');
  if (pick)
    await run(kit.env.DB, 'UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
      JSON.stringify({ follows: pick(doors) }),
      screen.id,
    ]);
  const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
    code: screen.pairing?.code,
  });
  const cookie = paired.headers.get('set-cookie');
  if (!cookie) throw new Error('Missing paired scanner cookie.');
  const attachment = await pairedScreenAttachment(kit, screen.id, cookie);
  return {
    session,
    doors,
    screen: screen.id,
    cookie,
    attachment,
    recipient: await liveRecipient(kit.ctx, attachment),
  };
}

describe('customer screen follows: limits and edits', () => {
  it('a default screen watches a session of 9 scanners', async () => {
    const { recipient, doors } = await screenOf('Nine default', 9);
    expect(recipient?.watch.scannerIds).toEqual([...doors].sort());
  });

  it('follows 9 and 16 scanners', async () => {
    const nine = await screenOf('Nine follows', 9, (ids) => ids);
    expect(nine.recipient?.watch.scannerIds).toHaveLength(9);
    const sixteen = await screenOf('Sixteen follows', 16, (ids) => ids);
    expect(sixteen.recipient?.watch.scannerIds).toHaveLength(16);
  });

  it('keeps stored follows of a revoked scanner out of the way of a rename', async () => {
    const { kit, authority } = fixtures;
    const { session, doors, screen } = await screenOf('Revoked', 2, (ids) => ids);
    await revokeScanner(kit.ctx, 'admin-1', doors[0] ?? '', authority);
    const kept = await updateScanningDevice(
      kit.ctx,
      'admin-1',
      session.id,
      screen,
      { name: 'Renamed screen' },
      authority,
    );
    expect(kept.name).toBe('Renamed screen');
    expect(kept.overrides.follows).toEqual(doors);
    await expect(
      updateScanningDevice(
        kit.ctx,
        'admin-1',
        session.id,
        screen,
        { overrides: { follows: [doors[0] ?? '', 'elsewhere'] } },
        authority,
      ),
    ).rejects.toMatchObject({ code: 'SCANNING_FOLLOWS_INVALID' });
  });

  it('drops follows when the device becomes a scanner', async () => {
    const { kit, authority } = fixtures;
    const { session, screen } = await screenOf('Role change', 2, (ids) => ids);
    const saved = await updateScanningDevice(
      kit.ctx,
      'admin-1',
      session.id,
      screen,
      { surface: 'operator' },
      authority,
    );
    expect(saved.overrides).toEqual({});
  });

  it('fails closed when the stored overrides no longer parse', async () => {
    const { kit } = fixtures;
    for (const raw of ['{"follows":[]}', '{"follows":"x"}', '{"bogus":true}', 'null', '[]']) {
      const { recipient, doors, screen, cookie } = await screenOf(`Bad ${raw}`, 2, (ids) => [
        ids[0] ?? '',
      ]);
      if (!recipient) throw new Error('Missing recipient.');
      expect(recipient.watch.scannerIds).toEqual([doors[0]]);
      await run(kit.env.DB, 'UPDATE scanning_devices SET overrides=? WHERE scanner_id=?', [
        raw,
        screen,
      ]);
      expect(await liveRecipient(kit.ctx, recipient.attachment)).toBeNull();
      await expect(pairedScreenAttachment(kit, screen, cookie)).rejects.toMatchObject({
        code: 'SCANNING_SESSION_SETTINGS_INVALID',
      });
    }
  });

  it('keeps follows out of a screen workspace', async () => {
    const { kit } = fixtures;
    const { cookie } = await screenOf('Workspace', 2, (ids) => ids);
    const res = await kit.get(
      { cookie: cookie.split(';')[0] ?? '', origin: 'https://wallet.test' },
      '/session',
    );
    expect(res.status).toBe(200);
    const body = JSON.stringify(await res.json());
    expect(body).toContain('overrides');
    expect(body).not.toContain('follows');
  });
});
