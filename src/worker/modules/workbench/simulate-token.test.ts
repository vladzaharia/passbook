import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makePass, makeTemplate } from '../../../../test/helpers/index.ts';
import { all } from '../../platform/db.ts';
import { workbenchKit } from './workbench-test-fixtures.ts';

let t: Awaited<ReturnType<typeof workbenchKit>>;
beforeAll(async () => {
  t = await workbenchKit();
});
afterAll(() => vi.unstubAllGlobals());

const passIn = async (orgId: string, mode: 'live' | 'test') => {
  const { resolved, registry } = makeTemplate({ id: `tpl-${orgId}`, orgId });
  return makePass(t.kit.f, { orgId, template: resolved, registry, mode });
};

describe('L7: a token simulates Test passes only', () => {
  it('refuses a Live pass and records nothing; a Test pass takes the event', async () => {
    const m = await t.member();
    const { token } = await t.wbMint(m.browser, m.orgId);
    const live = await passIn(m.orgId, 'live');
    const refused = await t.call('POST', `/passes/${live.id}/simulate`, t.asClient(token), {
      event: 'installed',
    });
    expect(refused.status, await refused.clone().text()).toBeGreaterThanOrEqual(400);
    expect(
      await all(t.kit.env.DB, 'SELECT 1 FROM pass_simulated_devices WHERE pass_id = ?', [live.id]),
    ).toEqual([]);

    const test = await passIn(m.orgId, 'test');
    const ok = await t.call('POST', `/passes/${test.id}/simulate`, t.asClient(token), {
      event: 'installed',
    });
    expect(ok.status, await ok.clone().text()).toBe(201);
  });
});
