import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { bindStaff, getScanner } from './repo-device.ts';
import { getStaff } from './repo-staff.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);

describe('device settings revision', () => {
  it('survives the device’s own staff sign-in but not another admin’s settings change', async () => {
    const { kit, parent, device, call } = fixture;
    const session = await parent('Own writes');
    const made = await device(session.id, 'Busy device', 'phone');
    const path = `/scanning-sessions/${session.id}/devices/${made.id}`;
    const person = await makeScanStaff(kit.fx, { orgId: kit.org.id });
    const [scanner, staff] = await Promise.all([
      getScanner(kit.env.DB, made.id),
      getStaff(kit.env.DB, kit.org.id, person.id),
    ]);
    const epoch = await kit.env.DB.prepare(
      'SELECT config_epoch FROM scanning_sessions WHERE id = ?',
    )
      .bind(session.id)
      .first<{ config_epoch: number }>();
    if (!scanner || !staff) throw new Error('Missing scanner or staff fixture.');
    await bindStaff(
      createServiceContext(kit.env, { clock: kit.clock }),
      scanner,
      { id: staff.id, authEpoch: staff.authEpoch ?? 0 },
      { id: session.id, configEpoch: epoch?.config_epoch ?? 0 },
    );
    const bound = await getScanner(kit.env.DB, made.id);
    expect(bound?.staffId).toBe(person.id);
    expect(bound?.updatedAt).not.toBe(made.updatedAt);
    const first = await call('PATCH', path, {
      name: 'Renamed once',
      revision: made.configRevision,
    });
    expect(first.status).toBe(200);
    const second = await call('PATCH', path, {
      name: 'Renamed twice',
      revision: made.configRevision,
    });
    expect(second.status).toBe(409);
  });
});
