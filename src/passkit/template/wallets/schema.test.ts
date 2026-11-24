import { describe, expect, it } from 'vitest';
import type { PassJson, TemplateManifest } from '../../types.ts';
import { CAPABILITY_IDS, WALLET_ROLES } from '../../wallets/vocab.ts';
import { WalletsManifestSchema } from './schema.ts';
import { walletsManifestIssues } from './validate.ts';

const FULL = {
  schema: 1,
  roles: {
    points: { field: 'points' },
    tier: { value: '{{level}}' },
    eventId: { value: '{{event_code}}' },
    balance: false,
    offerTitle: { value: { const: 'Free coffee' } },
  },
  required: ['barcode.format', 'type'],
  google: {
    type: 'loyalty',
    classKey: '{{event_code}}',
    omit: ['backFields.terms'],
    images: { logo: 'wallets/google/logo.png', hero: 'wallets/google/hero.png' },
  },
  samsung: {
    type: 'loyalty',
    subType: 'others',
    omit: [],
    images: { main: 'wallets/samsung/main.png' },
  },
};

const manifest = (wallets?: unknown): TemplateManifest =>
  ({
    schema: 1,
    name: 'Card',
    inputs: {
      type: 'object',
      properties: { level: { type: 'string' }, event_code: { type: 'string' } },
    },
    sample: {},
    bindings: [],
    display: { title: 'Card' },
    ...(wallets === undefined ? {} : { wallets }),
  }) as unknown as TemplateManifest;

const passJson = {
  storeCard: { primaryFields: [{ key: 'points', value: '1' }] },
} as unknown as PassJson;
const ART = Object.values(FULL.google.images).concat(FULL.samsung.images.main).sort();

const codes = (wallets: unknown, options = {}) =>
  walletsManifestIssues(manifest(wallets), { passJson, ...options }).map(
    (i) => `${i.severity}:${i.code}:${i.path}`,
  );

describe('wallets block vocabularies', () => {
  it('lists every role as a capability and keeps ids unique', () => {
    expect(new Set(CAPABILITY_IDS).size).toBe(CAPABILITY_IDS.length);
    for (const role of WALLET_ROLES) expect(CAPABILITY_IDS).toContain(`role.${role}`);
  });

  it('accepts capability ids, field paths and bare field keys in omit', () => {
    const omit = [
      'role.points',
      'barcode.format.pdf417',
      'backFields.terms',
      'additionalInfoFields.x',
      'terms',
    ];
    expect(codes({ schema: 1, google: { omit } })).toEqual([]);
    expect(codes({ schema: 1, samsung: { omit } })).toEqual([]);
  });

  it.each([
    [
      'an unknown capability id',
      { schema: 1, google: { omit: ['role.mood'] } },
      'wallets.google.omit.0',
    ],
    [
      'a field path in no group',
      { schema: 1, google: { omit: ['frontFields.x'] } },
      'wallets.google.omit.0',
    ],
    ['an unknown required id', { schema: 1, required: ['barcode.formt'] }, 'wallets.required.0'],
    ['a repeated required id', { schema: 1, required: ['type', 'type'] }, 'wallets.required'],
  ])('rejects %s', (_name, wallets, path) => {
    expect(codes(wallets)).toContain(`error:WALLETS_SHAPE:${path}`);
  });

  it('keeps every capability id valid as required', () => {
    for (const id of CAPABILITY_IDS) expect(codes({ schema: 1, required: [id] })).toEqual([]);
  });

  it.each([
    ['google', 'logo'],
    ['google', 'hero'],
    ['google', 'thumbnail'],
    ['samsung', 'logo'],
    ['samsung', 'main'],
    ['samsung', 'background'],
  ])('accepts the %s image slot %s', (name, slot) => {
    const block = { schema: 1, [name]: { images: { [slot]: `wallets/${name}/art.png` } } };
    expect(codes(block)).toEqual([]);
  });

  it.each([
    ['google', 'main'],
    ['samsung', 'hero'],
    ['google', 'Logo'],
    ['samsung', 'wide'],
  ])('rejects the %s image slot %s', (name, slot) => {
    const block = { schema: 1, [name]: { images: { [slot]: `wallets/${name}/art.png` } } };
    expect(codes(block).some((c) => c.startsWith('error:WALLETS_') && c.includes('images'))).toBe(
      true,
    );
  });
});

describe('wallets block schema', () => {
  it('accepts the architecture example and the minimal block', () => {
    expect(WalletsManifestSchema.safeParse(FULL).success).toBe(true);
    expect(WalletsManifestSchema.safeParse({ schema: 1 }).success).toBe(true);
    expect(codes(FULL, { assetNames: ART })).toEqual([]);
    expect(codes({ schema: 1 })).toEqual([]);
  });

  it('has no issues without the block', () => {
    expect(walletsManifestIssues(manifest())).toEqual([]);
  });

  it('accepts off as a type, to disable one wallet', () => {
    expect(codes({ schema: 1, google: { type: 'off' }, samsung: { type: 'off' } })).toEqual([]);
  });

  it.each([
    ['a wrong schema version', { ...FULL, schema: 2 }, 'WALLETS_VERSION', 'wallets.schema'],
    ['a missing schema version', { roles: {} }, 'WALLETS_VERSION', 'wallets.schema'],
    ['an unknown block key', { ...FULL, apple: {} }, 'WALLETS_UNKNOWN_KEY', 'wallets.apple'],
    [
      'an unknown target key',
      { schema: 1, google: { colour: 'red' } },
      'WALLETS_UNKNOWN_KEY',
      'wallets.google.colour',
    ],
    [
      'classKey on samsung',
      { schema: 1, samsung: { classKey: 'x' } },
      'WALLETS_UNKNOWN_KEY',
      'wallets.samsung.classKey',
    ],
    [
      'an unknown role',
      { schema: 1, roles: { mood: false } },
      'WALLETS_UNKNOWN_KEY',
      'wallets.roles.mood',
    ],
    [
      'a role with two sources',
      { schema: 1, roles: { tier: { field: 'a', value: 'b' } } },
      'WALLETS_ROLE',
      'wallets.roles.tier',
    ],
    [
      'a role set to true',
      { schema: 1, roles: { tier: true } },
      'WALLETS_ROLE',
      'wallets.roles.tier',
    ],
    [
      'a google type that does not exist',
      { schema: 1, google: { type: 'ticket' } },
      'WALLETS_TYPE',
      'wallets.google.type',
    ],
    [
      'a samsung subtype that does not exist',
      { schema: 1, samsung: { subType: 'concerts' } },
      'WALLETS_TYPE',
      'wallets.samsung.subType',
    ],
    [
      'a required id with a space',
      { schema: 1, required: ['barcode format'] },
      'WALLETS_SHAPE',
      'wallets.required.0',
    ],
    [
      'a repeated omit',
      { schema: 1, google: { omit: ['a', 'a'] } },
      'WALLETS_SHAPE',
      'wallets.google.omit',
    ],
    ['a block that is not an object', 'yes', 'WALLETS_SHAPE', 'wallets'],
    ['an array block', [], 'WALLETS_SHAPE', 'wallets'],
  ])('rejects %s', (_name, wallets, code, path) => {
    expect(codes(wallets)).toContain(`error:${code}:${path}`);
  });

  it('rejects too many list entries', () => {
    const omit = Array.from({ length: 51 }, (_, i) => `f${i}`);
    expect(codes({ schema: 1, google: { omit } })).toContain(
      'error:WALLETS_SHAPE:wallets.google.omit',
    );
  });

  it('refuses a class key that is a whole object or list', () => {
    const manifest = (inputs: object, classKey: string) =>
      ({
        inputs: { type: 'object', properties: inputs },
        wallets: { schema: 1, google: { classKey } },
      }) as never;
    const out = (m: never) => walletsManifestIssues(m).map((i) => `${i.severity}:${i.code}`);
    expect(out(manifest({ venue: { type: 'object' } }, '{{venue}}'))).toEqual([
      'error:WALLETS_CLASS_KEY',
    ]);
    expect(out(manifest({ venue: { type: 'object' } }, '{{venue.name}}'))).toEqual([]);
    expect(out(manifest({ tags: { type: 'array' } }, '{{tags}}'))).toEqual([
      'error:WALLETS_CLASS_KEY',
    ]);
    expect(out(manifest({ name: { type: 'string' } }, '{{name}}'))).toEqual([]);
  });

  it('warns when parts of a class key can run together', () => {
    const warns = (classKey: string) =>
      walletsManifestIssues({
        inputs: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } } },
        wallets: { schema: 1, google: { classKey } },
      } as never).map((i) => `${i.severity}:${i.code}`);
    for (const key of [
      '{{a}}{{b}}',
      '{{a}}|{{b}}',
      '{{a}} {{b}}',
      '{{a|url}}{{b|url}}',
      '{{a|url}}-{{b|url}}',
    ])
      expect(warns(key)).toEqual(['warning:WALLETS_CLASS_KEY']);
    for (const key of ['{{a}}', '{{a|url}}|{{b|url}}', '{{a|url}} {{b|url}}'])
      expect(warns(key)).toEqual([]);
  });

  it('checks expressions, inputs and lookups', () => {
    expect(codes({ schema: 1, roles: { tier: { value: '{{level | nope(}}' } } })).toEqual([
      expect.stringMatching(/^error:WALLETS_EXPR:wallets\.roles\.tier\.value$/),
    ]);
    expect(codes({ schema: 1, roles: { tier: { value: '{{missing}}' } } })).toEqual([
      'warning:WALLETS_INPUT:wallets.roles.tier.value',
    ]);
    expect(codes({ schema: 1, google: { classKey: '{{lookups.nope.x}}' } })).toEqual([
      'error:WALLETS_LOOKUP:wallets.google.classKey',
    ]);
  });

  it('warns on a role field that is not in pass.json', () => {
    expect(codes({ schema: 1, roles: { points: { field: 'ghost' } } })).toEqual([
      'warning:WALLETS_ROLE_FIELD:wallets.roles.points.field',
    ]);
    expect(
      codes({ schema: 1, roles: { points: { field: 'ghost' } } }, { passJson: undefined }),
    ).toEqual([]);
  });

  it('keeps art inside its own wallet folder', () => {
    const images = (google: Record<string, string>) => ({ schema: 1, google: { images: google } });
    for (const file of [
      'wallets/samsung/logo.png',
      'wallets/google/logo.jpg',
      'wallets/google/sub/logo.png',
      'wallets/google/../x.png',
      'icon.png',
    ])
      expect(codes(images({ logo: file }))).toEqual([
        'error:WALLETS_IMAGE:wallets.google.images.logo',
      ]);
  });

  it('looks art up only when the package file names are known', () => {
    const block = { schema: 1, google: { images: { logo: 'wallets/google/logo.png' } } };
    expect(codes(block)).toEqual([]);
    expect(codes(block, { assetNames: ['icon.png'] })).toEqual([
      'error:WALLETS_IMAGE_MISSING:wallets.google.images.logo',
    ]);
    expect(codes({ schema: 1 }, { assetNames: ['wallets/google/spare.png'] })).toEqual([
      'warning:WALLETS_ART_UNUSED:wallets/google/spare.png',
    ]);
  });
});
