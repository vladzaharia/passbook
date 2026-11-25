import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { create, h, keyBody, member, org, setup, teardown } from './test-kit.ts';

beforeEach(setup);
afterEach(teardown);

const DAY = 86_400_000;

describe('expiry choices of the admin create dialog', () => {
  it('a service key takes 7 days, 30, 90, 6 months, 1 year and no expiry', async () => {
    const { session } = await member('org_admin');
    for (const expiresAt of [7, 30, 90, 180, 365]
      .map((d) => h.clock.now() + d * DAY)
      .concat(null as never))
      expect((await create(session.headers, { ...keyBody(org.id), expiresAt })).status).toBe(201);
  });

  it('a personal key takes 7, 30 and 90 days, and refuses 6 months, 1 year and none', async () => {
    const { session } = await member('org_admin');
    const personal = (expiresAt: number | null) =>
      create(session.headers, { ...keyBody(org.id), kind: 'personal', expiresAt });
    for (const d of [7, 30, 90]) expect((await personal(h.clock.now() + d * DAY)).status).toBe(201);
    for (const d of [180, 365])
      await expectProblem(await personal(h.clock.now() + d * DAY), 422, 'API_KEY_EXPIRY_TOO_LONG');
    await expectProblem(await personal(null), 422, 'API_KEY_EXPIRY_REQUIRED');
  });
});
