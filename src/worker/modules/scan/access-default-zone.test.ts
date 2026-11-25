import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { saveOrgSettings, TEST_NOW } from '../../../../test/helpers/index.ts';
import { DEFAULT_TIME_ZONE } from '../../../shared/time-zone.ts';
import { accessTemplate, grantOf, makeDoor } from './access-test-fixtures.ts';
import { HOUR, kit, setupActionFixture } from './act-test-fixtures.ts';
import { readOrgTimeZone } from './repo-org-clock.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const setZone = (zone: string | null) =>
  saveOrgSettings(kit.env.DB, kit.org.id, { 'org.timeZone': zone }, TEST_NOW);

describe('an org with no time zone', () => {
  it('reads Seattle time, and its own zone once set', async () => {
    await setZone(null);
    expect(await readOrgTimeZone(kit.env.DB, kit.org.id)).toBe(DEFAULT_TIME_ZONE);
    await setZone('Europe/Berlin');
    expect(await readOrgTimeZone(kit.env.DB, kit.org.id)).toBe('Europe/Berlin');
  });

  it('keeps access hours on Seattle time', async () => {
    await setZone(null);
    const tpl = await accessTemplate();
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'off_peak' });
    // Monday 12:00 UTC is 05:00 in Seattle: before the 06:00 opening.
    expect(await grantOf(door.headers, pass)).toMatchObject({
      kind: 'refused',
      reason: 'outside_hours',
    });
    kit.clock.set(TEST_NOW + 3 * HOUR);
    expect(
      await grantOf(door.headers, await kit.scanPass(tpl, { plan: 'off_peak' })),
    ).toMatchObject({ kind: 'ok' });
  });

  it('follows an explicit UTC zone instead', async () => {
    await setZone('UTC');
    const tpl = await accessTemplate();
    const door = await makeDoor([tpl]);
    const pass = await kit.scanPass(tpl, { plan: 'off_peak' });
    expect(await grantOf(door.headers, pass)).toMatchObject({ kind: 'ok' });
  });
});
