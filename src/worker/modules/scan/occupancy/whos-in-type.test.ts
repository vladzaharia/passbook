import { beforeAll, describe, expect, it } from 'vitest';
import type { ScanWhosInList } from '../../../../shared/contracts/scan-whos-in.ts';
import { accessTemplate } from '../access-test-fixtures.ts';
import { kit, setupActionFixture } from '../act-test-fixtures.ts';
import {
  DISPLAY_TPL,
  personInside,
  station,
  trackedZone,
  useKit,
} from './whos-in-test-fixtures.ts';

let gym: string;
beforeAll(async () => {
  await setupActionFixture();
  useKit(kit);
  gym = await kit.scanTemplate('Gym', DISPLAY_TPL as never);
});

const list = async (h: Record<string, string>) =>
  (await (await kit.get(h, '/live/inside')).json()) as ScanWhosInList;

describe("who's in: pass type", () => {
  it('names the template of a pass without a plan, and the plan label where there is one', async () => {
    const acc = await accessTemplate();
    const pool = await trackedZone();
    const place = `zone:${pool.id}`;
    const now = kit.clock.now();
    await personInside(gym, 'Walker', [place], { at: now - 3000 });
    await personInside(acc, 'Visitor', [place], {
      at: now - 2000,
      input: { plan: 'guest', visits: 2 },
    });
    await personInside(acc, 'Member', [place], { at: now - 1000, input: { plan: 'gold' } });
    const s = await station([gym, acc], [pool.id]);
    const body = await list(s.headers);
    const type = Object.fromEntries(body.items.map((i) => [i.holder, i.type]));
    expect(type).toEqual({ Walker: 'Gym', Visitor: 'Guest day', Member: '24/7 Gold' });
  });
});
