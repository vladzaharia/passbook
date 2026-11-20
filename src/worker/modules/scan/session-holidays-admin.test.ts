import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { ScanningSessionDetailSchema } from '../../../shared/contracts/scanning-sessions.ts';
import { run } from '../../platform/db.ts';
import { scanningSessionsFixture } from './scanning-sessions-test-fixtures.ts';

// The kit's clock reads Monday 2026-06-01 12:00 UTC.
const WED = { wed: ['08:00-22:00'] };
const fixture = scanningSessionsFixture();
beforeAll(fixture.setup);
beforeEach(() => fixture.kit.clock.set(TEST_NOW));

const create = (hours: object | null) =>
  fixture.call('POST', '/scanning-sessions', {
    orgId: fixture.kit.org.id,
    name: `Dates ${fixture.kit.fx.ids.id()}`,
    timeZone: 'UTC',
    hours,
  });

describe('dated exceptions in the console', () => {
  it('stores dates, yesterday included', async () => {
    const res = await create({
      ...WED,
      dates: { '2026-05-31': ['18:00-02:00'], '2026-12-25': [] },
    });
    expect(res.status).toBe(201);
    const s = ScanningSessionDetailSchema.parse(await res.json());
    expect(s.hours?.dates).toEqual({ '2026-05-31': ['18:00-02:00'], '2026-12-25': [] });
  });

  it('refuses dates before yesterday or beyond two years with 422', async () => {
    expect((await create({ ...WED, dates: { '2026-05-30': [] } })).status).toBe(422);
    expect((await create({ ...WED, dates: { '2029-01-01': [] } })).status).toBe(422);
    expect((await create({ ...WED, dates: { '2028-05-31': [] } })).status).toBe(201);
  });

  it('refuses unsorted or overlapping spans on a date', async () => {
    const dates = (spans: string[]) => ({ ...WED, dates: { '2026-12-25': spans } });
    expect((await create(dates(['12:00-14:00', '09:00-10:00']))).status).toBe(422);
    expect((await create(dates(['09:00-12:00', '11:00-14:00']))).status).toBe(422);
    expect((await create(dates(['09:00-12:00', '12:00-14:00']))).status).toBe(201);
  });

  it('flags stored hours that no longer parse instead of reading as always open', async () => {
    const s = ScanningSessionDetailSchema.parse(await (await create(WED)).json());
    await run(fixture.kit.env.DB, 'UPDATE scanning_sessions SET hours = ? WHERE id = ?', [
      '{"wed":["nonsense"]}',
      s.id,
    ]);
    const got = ScanningSessionDetailSchema.parse(
      await (await fixture.call('GET', `/scanning-sessions/${s.id}`)).json(),
    );
    expect(got.hoursInvalid).toBe(true);
    expect(got.hours).toBeNull();
    expect(got.window).toMatchObject({ open: false, by: 'hours' });
  });
});
