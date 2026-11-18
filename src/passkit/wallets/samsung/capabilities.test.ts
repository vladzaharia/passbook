import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { CAPABILITY_IDS, SUPPORT_LEVELS, type Support } from '../types.ts';
import { SAMSUNG_CAPABILITIES } from './capabilities.ts';
import { compile, view } from './fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

const rank = (s: Support) => SUPPORT_LEVELS.indexOf(s);
const TYPES = ['loyalty', 'ticket', 'coupon'] as const;

describe('capability truth', () => {
  it('declares every capability for every type', () => {
    for (const type of TYPES)
      expect(Object.keys(SAMSUNG_CAPABILITIES[type]).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it.each(bakedSlugs())('%s never loses more than it declares', async (slug) => {
    const v = await view(slug);
    const forced = ['loyalty', 'ticket', 'coupon'].map((type) =>
      compile({ ...v, wallets: { schema: 1, samsung: { type } } } as never),
    );
    for (const r of [compile(v), ...forced]) {
      if (r.type === 'off') continue;
      const table = SAMSUNG_CAPABILITIES[r.type as (typeof TYPES)[number]];
      for (const item of r.items)
        expect(
          rank(item.support),
          `${r.type} ${item.capability} ${item.path}: ${item.support} is better than declared ${table[item.capability]}`,
        ).toBeGreaterThanOrEqual(rank(table[item.capability]));
    }
  });

  it('exercises the declared losses across the fixtures', async () => {
    const seen = new Set<string>();
    for (const slug of bakedSlugs()) {
      const v = await view(slug);
      for (const type of ['loyalty', 'ticket', 'coupon'])
        for (const i of compile({ ...v, wallets: { schema: 1, samsung: { type } } } as never).items)
          seen.add(i.capability);
    }
    for (const id of [
      'type',
      'colors.label',
      'sharing',
      'messaging.notify',
      'relevance.beacons',
      'image.thumbnail',
    ])
      expect(seen, id).toContain(id);
  });
});

describe('Samsung attributes', () => {
  it('never writes extendedFields (R10)', async () => {
    for (const slug of bakedSlugs())
      expect(JSON.stringify(compile(await view(slug)))).not.toContain('extendedFields');
    const here = import.meta.dirname;
    for (const name of readdirSync(here).filter(
      (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'),
    ))
      expect(readFileSync(join(here, name), 'utf8'), name).not.toContain('extendedFields');
  });

  it('uses documented attributes only', async () => {
    const known = new Set([
      'title',
      'providerName',
      'appLinkLogo',
      'appLinkName',
      'appLinkData',
      'logoImage',
      'bgImage',
      'mainImg',
      'bgColor',
      'fontColor',
      'startDate',
      'endDate',
      'noticeDesc',
      'locations',
      'amount',
      'balance',
      'issueDate',
      'expiry',
      'reservationNumber',
      'eventId',
      'editableYn',
      'deletableYn',
      'displayRedeemButtonYn',
      'notificationYn',
      'csInfo.call',
      'csInfo.email',
      'csInfo.webSite',
      'barcode.value',
      'barcode.serialType',
      'barcode.ptFormat',
      'barcode.ptSubFormat',
    ]);
    for (const slug of bakedSlugs()) {
      const data = compile(await view(slug)).cardData as { attributes: Record<string, string> };
      for (const key of Object.keys(data.attributes))
        expect(known, `${slug} ${key}`).toContain(key);
    }
  });
});
