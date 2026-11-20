import { describe, expect, it } from 'vitest';
import { SessionDevicesSchema } from '../../../shared/contracts/scanning-session-devices.ts';
import { run } from '../../platform/db.ts';
import {
  activityFixture,
  attach,
  workspace,
} from './repo-session-activity-authority-test-fixtures.ts';

async function devices(response: Response) {
  expect(response.status).toBe(200);
  return SessionDevicesSchema.parse(await response.json()).items;
}

describe('GET /scan/devices', () => {
  it("lists the scanners of the device's own session, marks itself, and none of another session", async () => {
    const f = await activityFixture({ role: 'desk' });
    const mate = await f.kit.scanner();
    await attach(f.kit, mate, f.sessionId);
    const elsewhere = await f.kit.scanner();
    await workspace(f.kit, elsewhere, null);
    const items = await devices(await f.request('/scan/devices', f.scanner.headers));
    expect(items.map((d) => d.id).sort()).toEqual([mate.id, f.scanner.id].sort());
    expect(items.map((d) => d.id)).not.toContain(elsewhere.id);
    expect(items.find((d) => d.id === f.scanner.id)?.self).toBe(true);
    expect(items.find((d) => d.id === mate.id)?.self).toBe(false);
  });

  it('is online by contact in the last two minutes, offline after', async () => {
    const f = await activityFixture({ role: 'desk' });
    const mate = await f.kit.scanner();
    await attach(f.kit, mate, f.sessionId);
    const seen = (at: number | null) =>
      run(f.kit.env.DB, 'UPDATE scanners SET last_seen_at = ? WHERE id = ?', [at, mate.id]);
    const state = async () =>
      (await devices(await f.request('/scan/devices', f.scanner.headers))).find(
        (d) => d.id === mate.id,
      );
    await seen(f.kit.clock.now() - 30_000);
    expect(await state()).toMatchObject({ online: true });
    await seen(f.kit.clock.now() - 5 * 60_000);
    expect(await state()).toMatchObject({ online: false, lastSeenAt: f.kit.clock.now() - 300_000 });
    await seen(null);
    expect(await state()).toMatchObject({ online: false, lastSeenAt: null });
  });

  it('leaves out a revoked device', async () => {
    const f = await activityFixture({ role: 'manager' });
    const mate = await f.kit.scanner();
    await attach(f.kit, mate, f.sessionId);
    await run(f.kit.env.DB, 'UPDATE scanners SET revoked_at = ? WHERE id = ?', [
      f.kit.clock.now(),
      mate.id,
    ]);
    const items = await devices(await f.request('/scan/devices', f.scanner.headers));
    expect(items.map((d) => d.id)).not.toContain(mate.id);
  });

  it('shows a Door device no names', async () => {
    const f = await activityFixture({ role: 'door' });
    const mate = await f.kit.scanner();
    await attach(f.kit, mate, f.sessionId);
    expect(await devices(await f.request('/scan/devices', f.scanner.headers))).toEqual([]);
  });

  it('is for a paired device: a console session and an unpaired caller are refused', async () => {
    const f = await activityFixture({ role: 'desk' });
    expect((await f.request('/scan/devices', {})).status).toBeGreaterThanOrEqual(400);
  });
});
