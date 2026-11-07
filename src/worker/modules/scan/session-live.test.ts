import { beforeAll, describe, expect, it } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { CreateScanningSessionSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { revokeSession } from '../auth/repo-sessions.ts';
import { scanHub } from './live.ts';
import { type LiveAttachment, liveRecipient } from './live-auth.ts';
import { getScanner } from './repo-device.ts';
import {
  createScanningDevice,
  joinAdminScanningSession,
  updateScanningDevice,
} from './scanning-devices.ts';
import { createScanningSession } from './scanning-sessions.ts';
import { type ScanKit, setupScanKit } from './test-kit.ts';

let kit: ScanKit;
beforeAll(async () => {
  kit = await setupScanKit();
  await makeUser(kit.fx, { id: 'admin-1' });
});
const parent = (name: string) =>
  createScanningSession(
    kit.ctx,
    'admin-1',
    'live',
    CreateScanningSessionSchema.parse({ orgId: kit.org.id, name, timeZone: 'UTC' }),
  );
const child = (sessionId: string, name: string, surface: 'phone' | 'desk' | 'customer' = 'phone') =>
  createScanningDevice(
    kit.ctx,
    'admin-1',
    'live',
    sessionId,
    { name, surface, overrides: {} },
    'https://wallet.test',
  );
async function pairedAttachment(
  sessionId: string,
  name: string,
  role: 'desk' | 'customer',
): Promise<LiveAttachment> {
  const device = await child(sessionId, name, role);
  const paired = await kit.post({ origin: 'https://wallet.test' }, '/pair', {
    code: device.pairing?.code,
  });
  expect(paired.status).toBe(200);
  const row = await getScanner(kit.env.DB, device.id);
  if (!row?.tokenHash || !row.expiresAt) throw new Error('Missing paired screen fixture.');
  return {
    orgId: kit.org.id,
    mode: 'live',
    scannerId: device.id,
    role: role === 'desk' ? 'monitor' : 'customer',
    tokenHash: row.tokenHash,
    revision: row.updatedAt,
    expiresAt: row.expiresAt,
  };
}
function row(scannerId: string): ScanLiveRow {
  return {
    id: kit.ctx.ids.ordered(),
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

describe('session display authorization', () => {
  it('follows new devices in its own session and excludes another session', async () => {
    const a = await parent('Display session A');
    const b = await parent('Display session B');
    const monitor = await pairedAttachment(a.id, 'A desk', 'desk');
    const customer = await pairedAttachment(a.id, 'A visitor', 'customer');
    // The screen is already connected when these scanners are enrolled.
    const sourceA = await child(a.id, 'A scanner');
    const sourceB = await child(b.id, 'B scanner');
    const hub = scanHub(kit.ctx, kit.org.id, 'live');
    for (const source of [sourceA, sourceB])
      await hub.publish({ orgId: kit.org.id, mode: 'live', row: row(source.id) });
    expect((await hub.snapshot(monitor)).rows).toMatchObject([
      { scannerId: sourceA.id, holder: 'Private name' },
    ]);
    expect((await hub.snapshot(monitor)).rows).toHaveLength(1);
    const publicRows = (await hub.snapshot(customer)).rows;
    expect(publicRows).toMatchObject([
      {
        scannerId: sourceA.id,
        holder: null,
        passId: null,
        photoUrl: null,
        scannerName: '',
        label: 'Checked in',
      },
    ]);
    expect(publicRows).toHaveLength(1);
  });

  it('allows an administrator device to use a display and revalidates its real platform session', async () => {
    const session = await parent('Admin display session');
    const joined = await joinAdminScanningSession(
      kit.ctx,
      'admin-1',
      'live',
      { sessionId: session.id, deviceKey: '33333333-3333-4333-8333-333333333333' },
      'https://wallet.test',
    );
    const device = await updateScanningDevice(kit.ctx, 'admin-1', session.id, joined.setupId, {
      surface: 'desk',
    });
    const auth = await makeSession(kit.fx, { userId: 'admin-1', roles: ['admin'] });
    const attachment: LiveAttachment = {
      orgId: kit.org.id,
      mode: 'live',
      scannerId: device.id,
      role: 'monitor',
      tokenHash: '',
      revision: device.updatedAt,
      expiresAt: kit.clock.now() + 60000,
      admin: { sessionId: await sha256Hex(auth.cookieValue), userId: 'admin-1' },
    };
    expect(await liveRecipient(kit.ctx, attachment)).not.toBeNull();
    expect(
      await liveRecipient(kit.ctx, {
        ...attachment,
        admin: { ...attachment.admin!, userId: 'other-admin' },
      }),
    ).toBeNull();
    await revokeSession(kit.env.DB, attachment.admin!.sessionId, kit.clock.now());
    expect(await liveRecipient(kit.ctx, attachment)).toBeNull();
  });
});
