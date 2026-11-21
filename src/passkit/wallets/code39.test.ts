import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../template/baked-fixtures.ts';
import { googleCompiler } from './google/compilers.ts';
import { googleView } from './google/fixtures.ts';
import { attributes, compile, NOW, view } from './samsung/fixtures.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

/** Google and Samsung both draw Code 39; a template whose first code is Code 39 must show one. */
describe('Code 39 on Google and Samsung', () => {
  it.each(bakedSlugs())('%s', async (slug) => {
    const g = await googleView(slug);
    const first = g.barcodes.find((b) => b.kind !== 'other');
    if (first?.kind !== 'code39') return;
    const out = googleCompiler.compile(g, { now: NOW, omit: [] });
    expect(JSON.stringify(out)).toContain('"type":"CODE_39"');
    expect(out.items.filter((i) => i.capability === 'barcode.format.code39')).toEqual([]);
    const s = compile(await view(slug));
    expect(JSON.stringify(attributes(s))).toContain('CODE_39');
  });
});
