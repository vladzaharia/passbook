import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeScanStaff,
} from '../../../../test/helpers/index.ts';
import { ManualClock } from '../../platform/clock.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { getStaff } from './repo-staff.ts';
import { checkPin } from './staff-pin.ts';

let f: Fixtures;
let clock: ManualClock;
let orgId: string;
beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  f = fixtures(await makeEnv(), clock);
  orgId = (await makeOrg(f)).id;
});

describe('a verified PIN', () => {
  it('signs in even when the attempt counter cannot be refunded', async () => {
    const person = await makeScanStaff(f, { orgId, pin: '482913' });
    const device = await makeScanner(f, { orgId, settings: { staffSignIn: true } });
    const staff = await getStaff(f.env.DB, orgId, person.id);
    let batches = 0;
    const real = f.env.DB;
    const flaky = new Proxy(real, {
      get(target, prop) {
        if (prop === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            // The first batch reserves and checks; the second is the refund.
            if (++batches > 1) throw new Error('refund down');
            return target.batch(statements);
          };
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const ctx = createServiceContext({ ...f.env, DB: flaky } as typeof f.env, { clock });
    await expect(
      checkPin(ctx, { scannerId: device.id, orgId, staffId: person.id, staff, pin: person.pin }),
    ).resolves.toBeUndefined();
    expect(batches).toBe(2);
  });
});
