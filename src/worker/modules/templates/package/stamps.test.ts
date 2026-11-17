import { describe, expect, it } from 'vitest';
import { type Analysis, analyzePackage } from './analyze.ts';
import { basicPackage, makePng } from './fixtures.ts';

const storeCard = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.example.template',
  teamIdentifier: 'TEAM000000',
  serialNumber: 'template',
  organizationName: 'Template',
  description: 'Stamp card',
  storeCard: { headerFields: [{ key: 'stamps', label: 'Stamps', value: '0 of 10' }] },
};

function manifest(goal: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    schema: 1,
    name: 'Coffee',
    inputs: {
      type: 'object',
      properties: { stamps: { type: 'integer', minimum: 0, maximum: 2 * goal - 1, default: 0 } },
    },
    sample: { stamps: 3 },
    bindings: [
      { to: { field: 'stamps' }, value: '{{pass.stamps.card}} of {{pass.stamps.goal}}' },
      {
        to: { field: 'stamps', prop: 'changeMessage' },
        value: '%@',
        when: { input: 'pass.stamps.ready', eq: true },
      },
    ],
    display: { title: 'Card' },
    stamps: {
      input: 'stamps',
      goal,
      art: { filled: 'stamps/filled.png', empty: 'stamps/empty.png' },
    },
    ...extra,
  });
}

function pkg(
  goal: number,
  extra: Record<string, Uint8Array | string | null> = {},
  m = manifest(goal),
) {
  return basicPackage(
    {
      'wallet.template.json': m,
      'strip@2x.png': makePng(750, 288),
      'strip@3x.png': makePng(1125, 432),
      'stamps/filled.png': makePng(256, 256),
      'stamps/empty.png': makePng(256, 256),
      ...extra,
    },
    storeCard,
  );
}

const run = (files: Map<string, Uint8Array>, counts: number[] = [0]) =>
  analyzePackage(files, { uploaded: true, fallbackName: 'x', stamps: { counts } });
const all = (goal: number) => Array.from({ length: goal + 1 }, (_, i) => i);
const errors = (r: Awaited<ReturnType<typeof run>>) =>
  r.report.issues.filter((i) => i.severity === 'error').map((i) => i.code);

// Drawing runs in workerd on a shared machine: most cases draw one count, the full set once.
describe('stamps in a package', { timeout: 180_000 }, () => {
  it('draws a strip pair per count and keeps the art as source', async () => {
    const result = (await run(pkg(5), all(5))) as Analysis;
    expect(errors(result)).toEqual([]);
    const strips = result.assets.filter((a) => a.stamps !== undefined);
    expect(strips).toHaveLength(2 * 6);
    expect(strips.every((a) => a.slot === 'strip' && a.width === 375 * a.scale)).toBe(true);
    expect(strips.map((a) => a.name)).toContain('stamps/strips/5/strip@3x.png');
    expect(result.assets.filter((a) => a.slot === 'source').map((a) => a.name)).toEqual([
      'stamps/empty.png',
      'stamps/filled.png',
    ]);
    expect(result.files.has('stamps/strips/0/strip@2x.png')).toBe(true);
  });

  it('gives the same version twice and a new one for another goal', async () => {
    const a = (await run(pkg(4), [1])) as Analysis;
    const b = (await run(pkg(4), [1])) as Analysis;
    const c = (await run(pkg(6), [1])) as Analysis;
    expect(a.version).toBe(b.version);
    expect(c.version).not.toBe(a.version);
  });

  it('draws only the sample count on a dry run', async () => {
    const result = (await run(pkg(8), [3])) as Analysis;
    expect(result.assets.filter((a) => a.stamps !== undefined).map((a) => a.stamps)).toEqual([
      3, 3,
    ]);
  });

  it('carries the strips of an earlier version with the same key, and keeps its version', async () => {
    const full = (await run(pkg(4), all(4))) as Analysis;
    const earlier = full.assets.filter((a) => a.stamps !== undefined);
    const keys: string[] = [];
    const carried = (await analyzePackage(pkg(4), {
      uploaded: true,
      fallbackName: 'x',
      stamps: {
        counts: [2],
        carry: async (key) => {
          keys.push(key);
          return earlier;
        },
      },
    })) as Analysis;
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(carried.version).toBe(full.version);
    expect(carried.assets.filter((a) => a.stamps !== undefined)).toHaveLength(10);
    const drawn = [...carried.files.keys()].filter((n) => n.startsWith('stamps/strips/'));
    expect(drawn).toEqual(['stamps/strips/2/strip@2x.png', 'stamps/strips/2/strip@3x.png']);
  });

  it('draws when no earlier version has the key, and keys follow the art', async () => {
    const keys: string[] = [];
    const carry = async (key: string) => {
      keys.push(key);
      return null;
    };
    const opts = { uploaded: true, fallbackName: 'x', stamps: { counts: [1], carry } };
    const a = (await analyzePackage(pkg(4), opts)) as Analysis;
    await analyzePackage(pkg(4), opts);
    await analyzePackage(pkg(4, { 'stamps/filled.png': makePng(300, 300) }), opts);
    await analyzePackage(pkg(5), opts);
    expect(a.assets.filter((x) => x.stamps !== undefined).map((x) => x.stamps)).toEqual([1, 1]);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
  });

  it('refuses uploaded generated strips', async () => {
    const result = await run(pkg(5, { 'stamps/strips/2/strip@2x.png': makePng(750, 288) }));
    expect(errors(result)).toContain('STAMPS_RESERVED');
  });

  it('wants both required art files', async () => {
    expect(errors(await run(pkg(5, { 'stamps/empty.png': null })))).toContain('STAMPS_ART');
  });

  it('wants square art of 128 to 1000 px', async () => {
    expect(errors(await run(pkg(5, { 'stamps/filled.png': makePng(256, 200) })))).toContain(
      'STAMPS_ART_SIZE',
    );
    expect(errors(await run(pkg(5, { 'stamps/filled.png': makePng(64, 64) })))).toContain(
      'STAMPS_ART_SIZE',
    );
  });

  it('warns about small art', async () => {
    const result = await run(pkg(5, { 'stamps/filled.png': makePng(200, 200) }));
    expect(errors(result)).toEqual([]);
    expect(result.report.issues.map((i) => i.code)).toContain('STAMPS_ART_SMALL');
  });

  it('wants the strip at exactly 750 x 288 and 1125 x 432', async () => {
    const result = await run(pkg(5, { 'strip@2x.png': makePng(750, 300) }));
    expect(errors(result).length).toBeGreaterThan(0);
  });

  it('works without a strip: the pass colour shows through', async () => {
    const result = (await run(
      pkg(3, { 'strip@2x.png': null, 'strip@3x.png': null }),
      all(3),
    )) as Analysis;
    expect(errors(result)).toEqual([]);
    expect(result.assets.filter((a) => a.stamps !== undefined)).toHaveLength(8);
  });

  it('refuses localized strips', async () => {
    const result = await run(pkg(5, { 'en.lproj/strip@2x.png': makePng(750, 288) }));
    expect(errors(result)).toContain('STAMPS_LOCALIZED');
  });

  it('rejects a goal out of range', async () => {
    expect(errors(await run(pkg(5, {}, manifest(21))))).toContain('STAMPS_GOAL');
  });

  it('draws every strip pair of a goal-20 version', async () => {
    // CPU time is asserted in src/passkit/stamps/compose.test.ts; workerd has no CPU meter.
    const result = (await run(pkg(20), all(20))) as Analysis;
    expect(result.assets.filter((a) => a.stamps !== undefined)).toHaveLength(42);
  }, 180_000);
});
