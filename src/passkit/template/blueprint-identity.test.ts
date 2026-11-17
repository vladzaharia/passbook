import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseColor } from '../schema/image-pixels.ts';
import { createFixtureIdentity } from '../testing/fixture-identity.ts';
import type { PassJson, SigningMaterial } from '../types.ts';
import { buildBaked, freezeNow, loadBaked } from './baked-fixtures.ts';

let material: SigningMaterial;
beforeAll(async () => {
  material = await createFixtureIdentity();
  freezeNow();
});

type Rgb = [number, number, number];
const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

/** The blueprint identities: text and labels are the spec's contrast against the background, all above AA (4.5). */
const IDENTITY: Record<string, { bg: Rgb; fg: Rgb; label: Rgb; text: number; labels: number }> = {
  'starter-generic': {
    bg: [20, 26, 43],
    fg: [255, 255, 255],
    label: [94, 234, 212],
    text: 17.3,
    labels: 11.7,
  },
  'starter-poster-generic': {
    bg: [54, 18, 115],
    fg: [255, 255, 255],
    label: [216, 199, 249],
    text: 14.1,
    labels: 9.0,
  },
  'starter-store-card': {
    bg: [0, 75, 65],
    fg: [255, 255, 255],
    label: [242, 208, 125],
    text: 10.1,
    labels: 6.8,
  },
  'starter-coupon': {
    bg: [181, 64, 0],
    fg: [255, 255, 255],
    label: [255, 238, 221],
    text: 5.7,
    labels: 5,
  },
  'starter-event-ticket': {
    bg: [94, 6, 54],
    fg: [255, 255, 255],
    label: [246, 197, 214],
    text: 13.5,
    labels: 8.9,
  },
  'starter-stamp-card': {
    bg: [252, 244, 230],
    fg: [49, 28, 15],
    label: [162, 64, 25],
    text: 14.7,
    labels: 5.9,
  },
  'starter-boarding-pass': {
    bg: [3, 82, 142],
    fg: [255, 255, 255],
    label: [191, 228, 251],
    text: 8.1,
    labels: 6.0,
  },
};

describe.each(Object.entries(IDENTITY))('%s identity', (slug, want) => {
  it('ships the identity colours and meets AA for text and labels', async () => {
    const { template } = await loadBaked(slug);
    const pass = template.passJson;
    expect(parseColor(pass.backgroundColor)).toEqual(want.bg);
    expect(parseColor(pass.foregroundColor)).toEqual(want.fg);
    expect(parseColor(pass.labelColor)).toEqual(want.label);
    expect(contrast(want.fg, want.bg)).toBeCloseTo(want.text, 1);
    expect(contrast(want.label, want.bg)).toBeCloseTo(want.labels, 1);
    expect(contrast(want.label, want.bg)).toBeGreaterThanOrEqual(4.5);
  });
});

it('gives every blueprint its own background', async () => {
  const seen = new Set<string>();
  for (const slug of Object.keys(IDENTITY)) {
    const { template } = await loadBaked(slug);
    seen.add(String(template.passJson.backgroundColor));
  }
  expect(seen.size).toBe(Object.keys(IDENTITY).length);
});

it('names each blueprint and gives it a curated glyph', async () => {
  const names: Record<string, [string, string]> = {
    'starter-generic': ['Membership card', 'id-card'],
    'starter-poster-generic': ['Poster card', 'sparkles'],
    'starter-store-card': ['Balance card', 'coins'],
    'starter-coupon': ['Coupon', 'percent'],
    'starter-event-ticket': ['Event ticket', 'music'],
    'starter-boarding-pass': ['Boarding pass', 'plane'],
    'starter-stamp-card': ['Stamp card', 'stamp'],
  };
  for (const [slug, [name, icon]] of Object.entries(names)) {
    const { template } = await loadBaked(slug);
    expect(template.manifest).toMatchObject({ name, blueprint: true, display: { icon } });
  }
});

it('names the store card a Balance card and leads with the balance', async () => {
  const { template } = await loadBaked('starter-store-card');
  expect(template.passJson.description).toBe('Balance card');
  expect(template.passJson.storeCard?.primaryFields?.[0]).toMatchObject({
    key: 'balance',
    currencyCode: 'USD',
  });
});

const PRE = join(import.meta.dirname, '__fixtures__/pre-blueprint');
// The Stamp card is new with blueprints: no earlier build to compare.
const UPGRADED = Object.keys(IDENTITY).filter((slug) => slug !== 'starter-stamp-card');
const IDENTITY_KEYS = ['backgroundColor', 'foregroundColor', 'labelColor', 'description'];
const walk = (v: unknown, path = ''): [string, unknown][] =>
  v && typeof v === 'object'
    ? Object.entries(v).flatMap(([k, x]) => walk(x, `${path}/${k}`))
    : [[path, v]];

describe('upgrade impact', () => {
  it.each(UPGRADED)('%s reissues silently: only colours and description change', async (slug) => {
    const before = JSON.parse(readFileSync(join(PRE, `${slug}.sample.golden`), 'utf8')) as PassJson;
    const after = (await buildBaked(slug, material)).passJson;
    const a = new Map(walk(before));
    const b = new Map(walk(after));
    const changed = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
    // Serial, token and the organization name are server-supplied and fixed in the fixture.
    const unexpected = changed.filter((k) => !IDENTITY_KEYS.includes(k.slice(1)));
    expect(unexpected).toEqual([]);
    expect(changed.length).toBeGreaterThan(0);
    // Wallet alerts only for a changed field value that carries a changeMessage: none changes.
    const fields = changed.filter((k) => /Fields\//.test(k));
    expect(fields).toEqual([]);
  });

  it('keeps every changeMessage and field key as before', async () => {
    for (const slug of UPGRADED) {
      const before = JSON.parse(
        readFileSync(join(PRE, `${slug}.sample.golden`), 'utf8'),
      ) as PassJson;
      const after = (await buildBaked(slug, material)).passJson;
      const messages = (p: PassJson) =>
        walk(p)
          .filter(([k]) => k.endsWith('/changeMessage'))
          .sort(([x], [y]) => x.localeCompare(y));
      expect(messages(after), slug).toEqual(messages(before));
    }
  });
});
