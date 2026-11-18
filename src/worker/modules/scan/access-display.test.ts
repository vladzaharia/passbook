import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TEST_NOW } from '../../../../test/helpers/index.ts';
import { ACCESS, grantOf, makeDoor, makeZone } from './access-test-fixtures.ts';
import { CHECK_IN, HOUR, kit, MINUTE, setupActionFixture } from './act-test-fixtures.ts';

beforeAll(setupActionFixture);
afterEach(() => kit.clock.set(TEST_NOW));

const DISPLAY = {
  v: 1,
  holder: '{{inputs.memberName}}',
  header: { chips: [{ id: 'c_plan', text: '{{access.plan}}', tone: 'violet' }] },
  panels: [
    {
      id: 'p_visits',
      title: 'Visits',
      rows: [
        {
          id: 'r_member',
          type: 'columns',
          items: [
            {
              id: 'i_month',
              label: 'This month',
              value: 'visits {{history.visits.month}}',
            },
            { id: 'i_zone', label: 'Zone', value: '{{access.zone}}' },
          ],
        },
      ],
    },
  ],
} as const;

describe('access: the result screen', () => {
  it('binds the access root and counts visits, not grants, in the history', async () => {
    const tpl = await kit.scanTemplate('Access card screen', {
      actions: [CHECK_IN],
      access: ACCESS,
      display: DISPLAY as never,
    });
    const zone = await makeZone('screen-room');
    const d = await makeDoor([tpl], [zone]);
    const pass = await kit.scanPass(tpl, { plan: 'gold' });
    const shown = async () => JSON.stringify((await grantOf(d.headers, pass)).display);

    const first = await shown();
    expect(first).toContain('24/7 Gold');
    expect(first).toContain('Zone screen-room');
    expect(first).toContain('visits 1');
    kit.clock.advance(30 * MINUTE);
    const inside = await shown();
    expect(inside).toContain('visits 1');
    expect(inside).not.toContain('visits 2');
    kit.clock.advance(3 * HOUR);
    expect(await shown()).toContain('visits 2');
  });
});
