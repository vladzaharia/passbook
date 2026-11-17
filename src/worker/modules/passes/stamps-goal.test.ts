import { beforeAll, describe, expect, it } from 'vitest';
import { assertStampsFit } from '../templates/stamps.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { getPass } from './repo-read-pass.ts';
import { stampMovePlan } from './stamps-keep.ts';
import {
  reissueStamps,
  releaseStamps,
  STAMP_CARD,
  stampCard,
  stampHeader,
  stampVersion,
} from './stamps-test-fixtures.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await setupKit();
}, 60_000);

/** A program at goal 10, released, so every test moves its own cards. */
async function program(id: string) {
  await stampVersion(kit, id, 'v1', 10);
  return releaseStamps(kit, id, 'v1');
}
const countOf = async (id: string) => (await getPass(kit.env.DB, id))?.personalization.stamps;

describe('goal changes on live Stamp cards', () => {
  it('is built from the generated Stamp card', () => {
    expect(STAMP_CARD.manifest.stamps?.goal).toBe(10);
  });

  it('alerts the cards a lowering makes ready, once, and nobody else', async () => {
    const v1 = await program('tpl-stamps-lower');
    const almost = await stampCard(kit, v1, 9);
    const fresh = await stampCard(kit, v1, 2);
    expect(await stampHeader(kit, almost.id)).toEqual({
      key: 'stamps',
      label: 'Stamps',
      value: '9 of 10',
    });
    await stampVersion(kit, 'tpl-stamps-lower', 'v2', 8);
    await releaseStamps(kit, 'tpl-stamps-lower', 'v2');
    expect(await reissueStamps(kit, 'tpl-stamps-lower')).toMatchObject({ failed: 0, changed: 2 });
    expect(await stampHeader(kit, almost.id)).toMatchObject({
      value: 'Reward ready',
      changeMessage: '%@',
    });
    const short = await stampHeader(kit, fresh.id);
    expect(short).toMatchObject({ value: '2 of 8' });
    expect(short?.changeMessage).toBeUndefined();
    expect(await countOf(almost.id)).toBe(9);
    expect((await getPass(kit.env.DB, almost.id))?.templateVersion).toBe('v2');
  });

  it('keeps ready cards ready on a raise when asked, once per card', async () => {
    const v1 = await program('tpl-stamps-keep');
    const ready = await stampCard(kit, v1, 10);
    const extra = await stampCard(kit, v1, 13);
    const short = await stampCard(kit, v1, 6);
    await stampVersion(kit, 'tpl-stamps-keep', 'v2', 12, { keepReady: true });
    await releaseStamps(kit, 'tpl-stamps-keep', 'v2');
    // The page runs twice: a retry never tops a card up again.
    await reissueStamps(kit, 'tpl-stamps-keep');
    expect(await countOf(ready.id)).toBe(12);
    expect(await countOf(extra.id)).toBe(15);
    expect(await countOf(short.id)).toBe(6);
    expect(await stampHeader(kit, ready.id)).toMatchObject({ value: 'Reward ready' });
    expect(await stampHeader(kit, short.id)).toMatchObject({ value: '6 of 12' });
  });

  it('lets ready cards fall short on a raise when not asked, silently', async () => {
    const v1 = await program('tpl-stamps-raise');
    const ready = await stampCard(kit, v1, 10);
    await stampVersion(kit, 'tpl-stamps-raise', 'v2', 12);
    await releaseStamps(kit, 'tpl-stamps-raise', 'v2');
    await reissueStamps(kit, 'tpl-stamps-raise');
    expect(await countOf(ready.id)).toBe(10);
    const header = await stampHeader(kit, ready.id);
    expect(header).toMatchObject({ value: '10 of 12' });
    expect(header?.changeMessage).toBeUndefined();
  });

  it('refuses releasing a version whose maximum is below a live count', async () => {
    const v1 = await program('tpl-stamps-max');
    await stampCard(kit, v1, 19);
    await stampCard(kit, v1, 18);
    await stampVersion(kit, 'tpl-stamps-max', 'v2', 10, { maximum: 15 });
    await expect(releaseStamps(kit, 'tpl-stamps-max', 'v2')).rejects.toMatchObject({
      code: 'STAMPS_ABOVE_MAX',
      message: '2 cards have more than 15 stamps. Raise the maximum to 19 in the designer.',
    });
    // Keeping rewards ready counts the topped-up count against the new maximum.
    await stampVersion(kit, 'tpl-stamps-max', 'v3', 12, { keepReady: true, maximum: 20 });
    await expect(releaseStamps(kit, 'tpl-stamps-max', 'v3')).rejects.toMatchObject({
      code: 'STAMPS_ABOVE_MAX',
      message: '1 card has more than 20 stamps. Raise the maximum to 21 in the designer.',
    });
    await stampVersion(kit, 'tpl-stamps-max', 'v4', 12, { keepReady: true, maximum: 21 });
    await expect(releaseStamps(kit, 'tpl-stamps-max', 'v4')).resolves.toMatchObject({
      version: 'v4',
    });
  });

  it("reads each card with its own version's input name, in the guard and in keep-ready", async () => {
    const v1 = await program('tpl-stamps-input');
    await stampCard(kit, v1, 19);
    const v2 = await stampVersion(kit, 'tpl-stamps-input', 'v2', 10, {
      input: 'visits',
      maximum: 15,
    });
    // The guard counts the v1 card under v1's `stamps`, not under v2's `visits`.
    await expect(
      assertStampsFit(
        kit.ctx,
        'tpl-stamps-input',
        { orgId: kit.org.id, mode: 'live' },
        v2.manifest,
      ),
    ).rejects.toMatchObject({ code: 'STAMPS_ABOVE_MAX' });
    // Keep-ready reads the ready card from `stamps` and tops it up in `visits`.
    const raised = await stampVersion(kit, 'tpl-stamps-input', 'v3', 12, {
      input: 'visits',
      keepReady: true,
    });
    const plan = await stampMovePlan(
      kit.ctx,
      { orgId: kit.org.id, templateId: 'tpl-stamps-input', version: raised.version },
      ['v1'],
    );
    expect(
      plan({ templateVersion: 'v1', personalization: { stamps: 10 }, fieldSources: {} }),
    ).toMatchObject({
      personalization: { stamps: 10, visits: 12 },
    });
    expect(
      plan({ templateVersion: 'v1', personalization: { stamps: 4 }, fieldSources: {} }),
    ).toEqual({});
  });
});
