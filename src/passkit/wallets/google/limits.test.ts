import { describe, expect, it } from 'vitest';
import type { ViewField, WalletPassView } from '../types.ts';
import { NOW } from '../view-fixtures.ts';
import { GOOGLE_COMPILERS } from './compilers.ts';
import { googleView } from './fixtures.ts';
import {
  BARCODE_MESSAGE,
  IDENTITY,
  MAX_BODY_BYTES,
  MAX_LOCATIONS,
  MAX_MODULES,
  MAX_URIS,
  TEXT,
} from './limits.ts';
import type { GoogleType } from './types.ts';

const compile = async (
  slug: string,
  type: GoogleType,
  patch?: (view: WalletPassView) => void,
  omit: string[] = [],
) => GOOGLE_COMPILERS[type].compile(await googleView(slug, { patch }), { now: NOW, omit });
const object = (r: { objectBody?: unknown }) => r.objectBody as Record<string, any>;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const field = (i: number, extra: Partial<ViewField> = {}): ViewField => ({
  group: 'back',
  key: `x${i}`,
  path: `backFields.x${i}`,
  order: 100 + i,
  label: `Label ${i}`,
  value: `value ${i}`,
  text: `value ${i}`,
  links: [],
  ...extra,
});

describe('limits', () => {
  it('are the documented numbers', () => {
    expect([MAX_MODULES, MAX_URIS, MAX_LOCATIONS, MAX_BODY_BYTES]).toEqual([10, 10, 10, 32_768]);
    expect([TEXT.title.max, TEXT.line.max, TEXT.body.max, TEXT.long.max]).toEqual([
      100, 200, 500, 2000,
    ]);
    expect([IDENTITY.max, BARCODE_MESSAGE.max]).toEqual([512, 2953]);
  });
});

describe('counts', () => {
  it('shows 10 text modules and folds the rest into the last, reporting each', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.fields = Array.from({ length: 13 }, (_, i) => field(i));
    });
    const modules = object(r).textModulesData;
    expect(modules).toHaveLength(10);
    expect(modules[9].body).toContain('value 9');
    expect(modules[9].body).toContain(
      '\nLabel 10: value 10\nLabel 11: value 11\nLabel 12: value 12',
    );
    expect(r.items.some((i) => i.support === 'omitted' && i.capability === 'field.back')).toBe(
      false,
    );
    const moved = r.items.filter(
      (i) => i.support === 'difference' && i.capability === 'field.back',
    );
    expect(moved.map((i) => i.path)).toEqual([
      'backFields.x10',
      'backFields.x11',
      'backFields.x12',
    ]);
    expect(moved[0]?.message).toBe('Google shows 10 text modules: carried as a line of "Label 9".');
  });

  it('folds the translations of overflow fields into the last module too', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.fields = Array.from({ length: 11 }, (_, i) => field(i));
      v.localization = {
        fr: {
          'Label 9': 'Etiquette 9',
          'Label 10': 'Etiquette 10',
          'value 9': 'valeur 9',
          'value 10': 'valeur 10',
        },
      };
    });
    const last = object(r).textModulesData[9];
    expect(last.body).toBe('value 9\nLabel 10: value 10');
    expect(last.localizedBody.translatedValues).toEqual([
      { language: 'fr', value: 'valeur 9\nEtiquette 10: valeur 10' },
    ]);
  });

  it('folds links past 10 into the last text module and reports each', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.fields = Array.from({ length: 12 }, (_, i) =>
        field(i, { links: [{ kind: 'web', url: `https://example.com/${i}` }] }),
      );
    });
    expect(object(r).linksModuleData.uris).toHaveLength(10);
    expect(object(r).textModulesData[9].body).toContain('https://example.com/10');
    expect(
      r.items.filter((i) => i.capability === 'field.link' && i.support === 'difference'),
    ).toHaveLength(2);
    expect(r.items.some((i) => i.capability === 'field.link' && i.support === 'omitted')).toBe(
      false,
    );
  });

  it('carries links past 10 in a new text module when there is none to fold into', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.fields = [];
      v.roles = {};
      v.links.urls = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`l${i}`, `https://example.com/${i}`]),
      );
    });
    expect(object(r).linksModuleData.uris).toHaveLength(10);
    expect(JSON.stringify(object(r).textModulesData)).toContain('https://example.com/10');
    expect(r.items.some((i) => i.capability === 'field.link' && i.support === 'omitted')).toBe(
      false,
    );
  });

  const points = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ latitude: 40 + i / 100, longitude: -70 }));

  it('sends 10 locations to Generic and says how many were left out', async () => {
    const r = await compile('starter-generic', 'generic', (v) => {
      v.relevance.locations = points(13);
    });
    expect(object(r).merchantLocations).toHaveLength(10);
    expect(r.items).toContainEqual({
      capability: 'relevance.locations',
      path: 'locations',
      support: 'omitted',
      message: 'Google carries 10 locations; 3 left out.',
    });
  });

  it('sends the venue once and as a typed location', async () => {
    const r = await compile('starter-event-ticket', 'event', (v) => {
      v.relevance.locations = points(2);
    });
    expect(object(r).locations).toHaveLength(3);
    const same = await compile('starter-event-ticket', 'event');
    expect(object(same).locations).toEqual([{ latitude: 37.3349, longitude: -122.009 }]);
  });

  it('lists upcoming events as one module on Generic and Event, and drops them elsewhere', async () => {
    const generic = await compile('starter-event-ticket', 'generic');
    const list = object(generic).textModulesData.find((m: { id: string }) => m.id === 'upcoming');
    expect(list.header).toBe('Upcoming');
    expect(list.body.split('\n')).toHaveLength(3);
    const loyalty = await compile('starter-event-ticket', 'loyalty');
    expect(JSON.stringify(object(loyalty))).not.toContain('Upcoming');
    expect(loyalty.items).toContainEqual({
      capability: 'upcoming.multi',
      path: 'events',
      support: 'omitted',
      message: 'This Google type shows one event.',
    });
  });
});

describe('bytes', () => {
  it('keeps the worst case under the body limit', async () => {
    for (const type of ['generic', 'event', 'loyalty', 'gift', 'offer'] as const) {
      const r = await compile('starter-event-ticket', type, (v) => {
        v.fields = Array.from({ length: 12 }, (_, i) =>
          field(i, {
            label: '€'.repeat(150),
            text: '€'.repeat(800),
            links: [
              {
                kind: 'web',
                url: `https://example.com/${'p'.repeat(200)}${i}`,
                text: '€'.repeat(200),
              },
            ],
          }),
        );
        v.relevance.locations = Array.from({ length: 12 }, (_, i) => ({
          latitude: i,
          longitude: i,
        }));
        v.roles.eventName = { kind: 'text', text: '€'.repeat(400), source: 'manifest', fields: [] };
        v.roles.offerTitle = {
          kind: 'text',
          text: '€'.repeat(400),
          source: 'manifest',
          fields: [],
        };
        v.roles.offerDetails = {
          kind: 'text',
          text: '€'.repeat(4000),
          source: 'manifest',
          fields: [],
        };
        v.roles.redemptionChannel = {
          kind: 'channel',
          channel: 'both',
          source: 'manifest',
          fields: [],
        };
        v.roles.giftCardNumber = {
          kind: 'text',
          text: '9'.repeat(512),
          source: 'manifest',
          fields: [],
        };
      });
      if (r.blocked) continue;
      expect(bytes(r.classBody), `${type} class`).toBeLessThanOrEqual(MAX_BODY_BYTES);
      expect(bytes(r.objectBody), `${type} object`).toBeLessThanOrEqual(MAX_BODY_BYTES);
    }
  });

  it('drops translations, and says so, when they push a body over the limit', async () => {
    const locales = Array.from({ length: 12 }, (_, i) => `l${i}`);
    const r = await compile('starter-generic', 'generic', (v) => {
      v.fields = Array.from({ length: 10 }, (_, i) =>
        field(i, { text: `v${i} ${'€'.repeat(400)}` }),
      );
      v.localization = Object.fromEntries(
        locales.map((l) => [
          l,
          Object.fromEntries(v.fields.map((f) => [f.text, `${l} ${'é'.repeat(450)}`])),
        ]),
      );
    });
    expect(bytes(r.objectBody)).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(JSON.stringify(r.objectBody)).not.toContain('translatedValues');
    expect(r.items).toContainEqual({
      capability: 'localization.strings',
      path: '',
      support: 'difference',
      message: 'Translations left out: the body is over the size limit.',
    });
  });
});

describe('what the template left out', () => {
  it('omits a field by path or bare key, and a capability by id', async () => {
    for (const omit of ['backFields.terms', 'terms']) {
      const r = await compile('starter-store-card', 'loyalty', undefined, [omit]);
      expect(object(r).textModulesData.map((m: { id: string }) => m.id)).not.toContain(
        'backFields.terms',
      );
      expect(r.items).toContainEqual({
        capability: 'field.back',
        path: 'backFields.terms',
        support: 'omitted',
        message: 'Left out by the template.',
      });
    }
    const hero = await compile('starter-event-ticket', 'event', undefined, ['image.strip']);
    expect((hero.classBody as Record<string, unknown>).heroImage).toBeUndefined();
    const loc = await compile('starter-event-ticket', 'generic', undefined, [
      'relevance.locations',
    ]);
    expect(object(loc).merchantLocations).toBeUndefined();
  });

  it('drops a role and its field together', async () => {
    const r = await compile('starter-store-card', 'loyalty', undefined, ['role.balance']);
    expect(object(r).secondaryLoyaltyPoints).toBeUndefined();
    expect(JSON.stringify(object(r).textModulesData)).not.toContain('primaryFields.balance');
    expect(r.items).toContainEqual({
      capability: 'role.balance',
      path: '',
      support: 'omitted',
      message: 'Left out by the template.',
    });
  });
});
