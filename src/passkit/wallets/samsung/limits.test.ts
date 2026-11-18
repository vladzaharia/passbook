import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import { measure } from '../text.ts';
import type { RoleValue, ViewField } from '../types.ts';
import { attributes, compile, view } from './fixtures.ts';
import { SAMSUNG_LIMITS } from './limits.ts';

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

const text = (value: string): RoleValue => ({
  kind: 'text',
  text: value,
  source: 'manifest',
  fields: [],
});
const bytes = (value: string) => new TextEncoder().encode(value).length;
const field = (i: number, value: string, label = `L${i}`): ViewField => ({
  group: 'back',
  key: `f${i}`,
  path: `backFields.f${i}`,
  order: 100 + i,
  label,
  value,
  text: value,
  links: [],
});

describe('every attribute stays inside its byte limit', () => {
  it.each(bakedSlugs())('%s', async (slug) => {
    const a = attributes(compile(await view(slug)));
    for (const [key, limit] of Object.entries(SAMSUNG_LIMITS))
      if (a[key] !== undefined)
        expect(measure(a[key], 'bytes'), key).toBeLessThanOrEqual(limit.max);
  });

  it('holds with long and multibyte values everywhere', async () => {
    const v = await view('starter-event-ticket');
    v.org = '組織'.repeat(30);
    v.roles.title = text('タイトル'.repeat(20));
    v.roles.eventName = text(`Event ${'é'.repeat(80)}`);
    const a = attributes(compile(v, { portalUrl: 'https://p.example' }));
    expect(a.providerName).toMatch(/…$/u);
    for (const key of ['title', 'providerName', 'appLinkName'] as const)
      expect(bytes(a[key] as string), key).toBeLessThanOrEqual(32);
    expect(a.title).not.toContain('�');
  });
});

describe('display text is shortened and reported (Q20)', () => {
  it('cuts a long title at a character boundary and reports it once', async () => {
    const v = await view('starter-store-card');
    v.roles.title = text('A very long loyalty card title that cannot fit');
    const r = compile(v);
    const title = attributes(r).title as string;
    expect(title.endsWith('…')).toBe(true);
    expect(bytes(title)).toBeLessThanOrEqual(32);
    const items = r.items.filter((i) => i.capability === 'text.length' && i.path === 'title');
    expect(items).toEqual([
      {
        capability: 'text.length',
        path: 'title',
        support: 'difference',
        message: 'Shortened to 32 bytes.',
      },
    ]);
  });

  it('reports nothing for a title that fits', async () => {
    const r = compile(await view('starter-store-card'));
    expect(r.items.some((i) => i.capability === 'text.length')).toBe(false);
  });
});

describe('identity values are never shortened (Q20)', () => {
  it('passes a 4096-byte barcode message unchanged and blocks 4097', async () => {
    const v = await view('starter-store-card');
    const barcode = v.barcodes[0];
    if (!barcode) throw new Error('fixture has a barcode');
    const fit = 'x'.repeat(4096);
    v.barcodes = [{ ...barcode, message: fit, altText: fit }];
    expect(attributes(compile(v))['barcode.value']).toBe(fit);
    v.barcodes = [{ ...barcode, message: `${fit}x` }];
    const r = compile(v);
    expect(r.blocked?.code).toBe('IDENTITY_TOO_LONG');
    expect(r.cardData).toBeUndefined();
  });

  it('blocks a confirmation code over 32 bytes instead of cutting it', async () => {
    const v = await view('starter-event-ticket');
    v.roles.confirmationCode = text('C'.repeat(33));
    const r = compile(v);
    expect(r.blocked?.code).toBe('IDENTITY_TOO_LONG');
  });

  it('keeps a member id whole in a full notice and drops display text first', async () => {
    const v = await view('starter-stamp-card');
    v.roles.memberId = text('M'.repeat(300));
    v.fields = [...v.fields, ...Array.from({ length: 12 }, (_, i) => field(i, 'w'.repeat(600)))];
    const a = attributes(compile(v));
    const notice = a.noticeDesc as string;
    expect(bytes(notice)).toBeLessThanOrEqual(5000);
    expect(notice).toContain(`Member ID: ${'M'.repeat(300)}`);
    expect(notice).not.toContain('f11');
  });

  it('blocks when identity lines alone overflow the notice', async () => {
    const v = await view('starter-stamp-card');
    v.roles.memberId = text('M'.repeat(5000));
    expect(compile(v).blocked?.code).toBe('IDENTITY_TOO_LONG');
  });
});

describe('the notice and the other bounded slots', () => {
  it('fills the notice to 5000 bytes: shortens the first line that overflows, drops the rest', async () => {
    const v = await view('starter-stamp-card');
    v.fields = [...v.fields, ...Array.from({ length: 12 }, (_, i) => field(i, `${i}`.repeat(600)))];
    const r = compile(v);
    const notice = attributes(r).noticeDesc as string;
    expect(bytes(notice)).toBeLessThanOrEqual(5000);
    expect(notice.endsWith('…')).toBe(true);
    expect(r.items.some((i) => i.support === 'omitted' && i.capability === 'field.back')).toBe(
      true,
    );
    expect(r.items.some((i) => i.capability === 'text.length')).toBe(true);
  });

  it('writes at most ten locations inside 1024 bytes and reports the rest', async () => {
    const v = await view('starter-store-card');
    v.relevance = {
      ...v.relevance,
      locations: Array.from({ length: 14 }, (_, i) => ({
        latitude: 40 + i / 100,
        longitude: -70 - i / 100,
        relevantText: `Branch ${i}`,
      })),
    };
    const r = compile(v);
    const json = attributes(r).locations as string;
    expect(JSON.parse(json).length).toBe(10);
    expect(bytes(json)).toBeLessThanOrEqual(1024);
    expect(r.items.filter((i) => i.capability === 'relevance.locations')).toHaveLength(4);
  });

  it('leaves a phone number that does not fit in the notice', async () => {
    const v = await view('henrys-blue');
    v.roles.support = {
      kind: 'links',
      links: [{ kind: 'tel', url: `tel:+${'1'.repeat(40)}` }],
      source: 'manifest',
      fields: [],
    };
    expect(attributes(compile(v))['csInfo.call']).toBeUndefined();
  });

  it('drops an image address over 256 bytes with an omission, never cutting it', async () => {
    const v = await view('starter-store-card');
    const logo = v.images.apple.logo?.[0];
    if (!logo) throw new Error('fixture has a logo');
    v.images.apple.logo = [{ ...logo, url: `https://img.example/${'a'.repeat(300)}.png` }];
    const r = compile(v);
    expect(attributes(r).logoImage).toBeUndefined();
    expect(r.items).toContainEqual(
      expect.objectContaining({ capability: 'image.logo', support: 'omitted' }),
    );
  });
});

describe('plain text only', () => {
  it('strips markup and controls from notice text', async () => {
    const v = await view('starter-stamp-card');
    v.fields = [...v.fields, field(1, '<b>Bold</b>\u0007 text', 'Note')];
    expect(attributes(compile(v)).noticeDesc).toContain('Note: Bold  text');
  });
});
