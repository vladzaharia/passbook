import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { PassDetailSchema } from '../../../shared/contracts/passes.ts';
import { createApp } from '../../app.ts';
import { all, run } from '../../platform/db.ts';
import { notifiesHolder, overBudget, pushBudgetOf } from './change-messages.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { releaseStamps, stampCard, stampVersion } from './stamps-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

const ID = 'tpl-stamp-actions';
let kit: Kit;
let auth: TenantTestAuth;
let app: ReturnType<typeof createApp>;
let release: Awaited<ReturnType<typeof releaseStamps>>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
  await stampVersion(kit, ID, 'v1', 10);
  release = await releaseStamps(kit, ID, 'v1');
}, 60_000);

const stamp = (passId: string, body: unknown, headers = auth.admin()) =>
  app.request(
    `https://wallet.test/api/v1/passes/${passId}/stamps`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const detail = async (res: Response) => PassDetailSchema.parse(await res.json());

/** Every built version of a pass, oldest first, and whether each one alerted the holder. */
async function history(passId: string) {
  const rows = await all<{ pass_json: string }>(
    kit.env.DB,
    'SELECT pass_json FROM pass_versions WHERE pass_id = ? ORDER BY version',
    [passId],
  );
  const passes = rows.map((r) => JSON.parse(r.pass_json) as PassJson);
  return passes.map((p, i) => ({
    header: (p as { storeCard?: { headerFields?: { value: string }[] } }).storeCard
      ?.headerFields?.[0]?.value,
    alerts: notifiesHolder(p, passes[i - 1] ?? null),
  }));
}

describe('stamp actions', () => {
  it('needs a pass writer', async () => {
    const card = await stampCard(kit, release, 0);
    expect((await stamp(card.id, { action: 'add' }, auth.user())).status).toBe(403);
    const reader = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await stamp(card.id, { action: 'add' }, reader)).status).toBe(403);
    expect((await stamp(card.id, { action: 'add' })).status).toBe(200);
  });

  it('refuses a pass without stamps', async () => {
    const plain = await kit.pass();
    const res = await stamp(plain.id, { action: 'add' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'STAMPS_NONE' });
  });

  it('alerts the holder once per card: the stamp that fills it', async () => {
    const card = await stampCard(kit, release, 8);
    const nine = await detail(await stamp(card.id, { action: 'add' }));
    expect(nine.stamps).toEqual({
      input: 'stamps',
      goal: 10,
      count: 9,
      card: 9,
      ready: false,
      maximum: 19,
    });
    expect((await detail(await stamp(card.id, { action: 'add' }))).stamps).toMatchObject({
      count: 10,
      ready: true,
    });
    // Stamps while ready change nothing the holder sees: stored, not published.
    const twelve = await detail(await stamp(card.id, { action: 'add', count: 2 }));
    expect(twelve.stamps).toMatchObject({ count: 12, card: 10, ready: true });
    const redeemed = await detail(await stamp(card.id, { action: 'redeem' }));
    expect(redeemed.stamps).toMatchObject({ count: 2, card: 2, ready: false });
    expect(await history(card.id)).toEqual([
      { header: '8 of 10', alerts: false },
      { header: '9 of 10', alerts: false },
      { header: 'Reward ready', alerts: true },
      { header: '2 of 10', alerts: false },
    ]);
    expect((await getPass(kit.env.DB, card.id))?.fieldSources.stamps).toBe('manual');
  });

  it('refuses a redeem below the goal and an add past the maximum', async () => {
    const card = await stampCard(kit, release, 7);
    const early = await stamp(card.id, { action: 'redeem' });
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({
      code: 'STAMPS_NO_REWARD',
      detail: 'No reward yet: 7 of 10 stamps.',
    });
    const full = await stampCard(kit, release, 18);
    expect((await detail(await stamp(full.id, { action: 'add' }))).stamps?.count).toBe(19);
    const over = await stamp(full.id, { action: 'add' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ code: 'STAMPS_CARD_FULL' });
    expect((await stamp(full.id, { action: 'add', count: 0 })).status).toBe(422);
    expect((await getPass(kit.env.DB, full.id))?.personalization.stamps).toBe(19);
  });

  it('counts what a goal change does to the live cards', async () => {
    await stampVersion(kit, 'tpl-stamp-impact', 'v1', 10);
    const v1 = await releaseStamps(kit, 'tpl-stamp-impact', 'v1');
    for (const n of [0, 7, 9, 10, 12]) await stampCard(kit, v1, n);
    const impact = async (query: string, headers = auth.admin()) =>
      app.request(
        `https://wallet.test/api/v1/templates/tpl-stamp-impact/stamps-impact?${query}`,
        { headers },
        kit.env,
      );
    const lower = await impact('goal=8');
    expect(lower.status).toBe(200);
    expect(await lower.json()).toEqual({
      passes: 5,
      readyNow: 2,
      readyLost: 0,
      newlyReady: 1,
      highest: 12,
      highestKept: 12,
    });
    expect(await (await impact('goal=12')).json()).toMatchObject({
      readyNow: 2,
      readyLost: 1,
      newlyReady: 0,
      highestKept: 14,
    });
    expect((await impact('goal=21')).status).toBe(422);
    expect((await impact('goal=8', auth.user())).status).toBe(404);
    const plain = await app.request(
      `https://wallet.test/api/v1/templates/${kit.template.id}/stamps-impact?goal=8`,
      { headers: auth.admin() },
      kit.env,
    );
    expect(plain.status).toBe(409);
    expect(await plain.json()).toMatchObject({ code: 'STAMPS_NONE' });
  });

  it('stays inside its organization and mode', async () => {
    const card = await stampCard(kit, release, 2);
    const other = await makeOrg(kit.fx, { name: 'Other Org' });
    const scopes = ['passes:read', 'passes:write'] as const;
    const elsewhere = await auth.apiKey({ orgId: other.id, scopes: [...scopes] });
    const wrongOrg = await stamp(card.id, { action: 'add' }, elsewhere);
    expect([403, 404]).toContain(wrongOrg.status);
    const sandbox = await auth.apiKey({ orgId: kit.org.id, scopes: [...scopes], mode: 'test' });
    const wrongMode = await stamp(card.id, { action: 'add' }, sandbox);
    expect([403, 404, 409]).toContain(wrongMode.status);
    expect((await getPass(kit.env.DB, card.id))?.personalization.stamps).toBe(2);
    // Positive control: the same card takes the stamp from its own organization and mode.
    const own = await auth.apiKey({ orgId: kit.org.id, scopes: [...scopes] });
    expect((await stamp(card.id, { action: 'add' }, own)).status).toBe(200);
    expect((await getPass(kit.env.DB, card.id))?.personalization.stamps).toBe(3);
  });

  it('counts two desks adding at once, and alerts once', async () => {
    const card = await stampCard(kit, release, 8);
    const both = await Promise.all([
      stamp(card.id, { action: 'add' }),
      stamp(card.id, { action: 'add' }),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect((await getPass(kit.env.DB, card.id))?.personalization.stamps).toBe(10);
    const alerts = (await history(card.id)).filter((h) => h.alerts);
    expect(alerts).toEqual([{ header: 'Reward ready', alerts: true }]);
  });

  it('keeps one consistent count when an add meets a redeem', async () => {
    const card = await stampCard(kit, release, 10);
    const both = await Promise.all([
      stamp(card.id, { action: 'add' }),
      stamp(card.id, { action: 'redeem' }),
    ]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    // Add then redeem is 11 - 10, redeem then add is 0 + 1.
    expect((await getPass(kit.env.DB, card.id))?.personalization.stamps).toBe(1);
  });

  it('alerts the stamp that fills a card even at the daily push limit', async () => {
    const card = await stampCard(kit, release, 9);
    const at = kit.clock.now();
    for (let i = 0; i < 3; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
         VALUES (?, ?, ?, 'live', 'pass.updated', '{"notified":1}', ?)`,
        [kit.fx.ids.id(), kit.org.id, card.id, at],
      );
    // The premise: this pass is at its limit, so any other notifying update would go out silent.
    expect(overBudget(await pushBudgetOf(kit.ctx, card.id))).toBe(true);
    const res = await detail(await stamp(card.id, { action: 'add' }));
    expect(res.stamps).toMatchObject({ count: 10, ready: true });
    expect((await history(card.id)).filter((h) => h.alerts)).toEqual([
      { header: 'Reward ready', alerts: true },
    ]);
  });
});
