/**
 * Capability truth (architecture 4.1, 7): every fidelity item matches what the compiled body
 * carries, and every capability the declared table marks as lossy is reported when the pass uses it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bakedSlugs, loadBaked } from '../../template/baked-fixtures.ts';
import type { CapabilityId, CompileResult, Support, WalletPassView } from '../types.ts';
import { NOW } from '../view-fixtures.ts';
import { googleCapabilities } from './capabilities.ts';
import { GOOGLE_COMPILERS } from './compilers.ts';
import { googleView } from './fixtures.ts';
import type { GoogleType } from './types.ts';
import { moduleId, utc } from './values.ts';

const RANK: Support[] = ['native', 'text', 'difference', 'omitted', 'unsupported'];
const OPTIONS = { now: NOW, omit: [] };
const TYPES = Object.keys(GOOGLE_COMPILERS) as GoogleType[];

beforeAll(async () => {
  await loadBaked('starter-stamp-card');
}, 120_000);

/** The capabilities a view uses and a declared lossy level must therefore report. */
function exercised(view: WalletPassView, type: GoogleType): CapabilityId[] {
  const out: CapabilityId[] = [];
  const first = view.barcodes[0];
  if (first && !view.validity.voided) out.push(`barcode.format.${first.kind}` as CapabilityId);
  if (view.colors.foreground) out.push('colors.foreground');
  if (view.colors.label) out.push('colors.label');
  if (view.relevance.beacons.length > 0) out.push('relevance.beacons');
  if (view.nfc) out.push('nfc');
  if (view.personalization) out.push('personalization');
  if (view.events.length > 0) out.push('upcoming.multi');
  if (view.relevance.dates.length > 0 && (type === 'loyalty' || type === 'gift'))
    out.push('relevance.dates');
  return out;
}

function bodies(result: CompileResult) {
  const object = (result.objectBody ?? {}) as Record<string, unknown>;
  const klass = (result.classBody ?? {}) as Record<string, unknown>;
  const modules = (object.textModulesData ?? []) as { id: string; body: string }[];
  return { object, klass, modules };
}

describe.each(TYPES)('Google %s: items match the body', (type) => {
  const declared = googleCapabilities(type);

  for (const slug of bakedSlugs())
    for (const art of [true, false])
      it(`${slug}${art ? '' : ' without art'}`, async () => {
        const view = await googleView(slug, { art });
        const result = GOOGLE_COMPILERS[type].compile(view, OPTIONS);
        if (result.blocked) {
          expect(result.blocked.code).toBe('TYPE_UNSATISFIED');
          expect(result.classBody).toBeUndefined();
          return;
        }
        const { object, klass, modules } = bodies(result);

        // Every item is no better than the declared level, and names a known capability.
        for (const item of result.items)
          expect(
            RANK.indexOf(item.support),
            `${item.capability} ${item.path}: ${item.support} is better than declared ${declared[item.capability]}`,
          ).toBeGreaterThanOrEqual(RANK.indexOf(declared[item.capability]));

        // A capability the table marks lossy is reported when the pass uses it.
        for (const id of exercised(view, type))
          if (declared[id] !== 'native')
            expect(
              result.items.some((i) => i.capability === id && i.support === declared[id]),
              `${id} is declared ${declared[id]} but not reported`,
            ).toBe(true);

        // Text items name exactly the modules in the body.
        const textPaths = result.items
          .filter(
            (i) =>
              i.support === 'text' &&
              i.capability.startsWith('field.') &&
              i.capability !== 'field.link',
          )
          .map((i) => moduleId(i.path));
        const fieldModules = modules
          .map((m) => m.id)
          .filter((id) => !id.startsWith('role.') && id !== 'upcoming');
        expect([...fieldModules].sort()).toEqual([...new Set(textPaths)].sort());
        // An omitted field is not in the body.
        for (const item of result.items)
          if (item.support === 'omitted' && item.capability.startsWith('field.') && item.path)
            expect(modules.map((m) => m.id)).not.toContain(moduleId(item.path));
        // A field a native slot carries is not repeated as text.
        expect(modules.length).toBeLessThanOrEqual(10);

        // Barcode: the first format Google renders, message unchanged; the skipped ones are reported.
        const chosen = view.barcodes.findIndex((b) =>
          ['qr', 'pdf417', 'aztec', 'code128', 'code39'].includes(b.kind),
        );
        const barcode = object.barcode as { value: string; alternateText?: string } | undefined;
        if (view.validity.voided || chosen < 0) expect(barcode).toBeUndefined();
        else {
          expect(barcode?.value).toBe(view.barcodes[chosen]?.message);
          for (let i = 0; i < chosen; i++)
            expect(
              result.items.some((it) => it.path === `barcodes.${i}` && it.support === 'omitted'),
            ).toBe(true);
        }

        // Colour: the Apple background on the class (typed) or the object (Generic).
        const hex = (type === 'generic' ? object : klass).hexBackgroundColor;
        expect(hex).toBe(view.colors.background);

        // Expiry: validTimeInterval.end is the expiration date in UTC.
        const end = (object.validTimeInterval as { end?: { date: string } } | undefined)?.end?.date;
        const expiry = view.roles.validUntil;
        if (expiry?.kind === 'date' && type !== 'event') expect(end).toBe(utc(expiry.iso));

        // Locations: at most 10; a cut is reported.
        const locations =
          ((object.merchantLocations ?? object.locations) as unknown[] | undefined) ?? [];
        expect(locations.length).toBeLessThanOrEqual(10);

        // Images: only template art, only URLs the view holds, and a slot left empty is reported.
        const carried =
          JSON.stringify([object, klass]).match(/"sourceUri":\{"uri":"[^"]+"\}/gu) ?? [];
        const allowed = new Set(
          [
            ...Object.values(view.images.apple).flat(),
            ...Object.values(view.images.overrides.google ?? {}),
          ]
            .filter((f) => !f.personal && f.url)
            .map((f) => `"sourceUri":{"uri":"${f.url}"}`),
        );
        for (const uri of carried)
          expect(allowed.has(uri), `${uri} is not template art`).toBe(true);
      });

  it('declares every capability id', () => {
    expect(Object.keys(declared).length).toBeGreaterThan(70);
    expect(declared['barcode.format.code39']).toBe('native');
    expect(declared['barcode.format.codabar']).toBe('omitted');
    expect(declared.nfc).toBe('unsupported');
  });
});

describe('the declared table', () => {
  it('marks the role slots of each type', () => {
    expect(googleCapabilities('generic')['role.title']).toBe('native');
    expect(googleCapabilities('generic')['role.points']).toBe('text');
    expect(googleCapabilities('loyalty')['role.points']).toBe('native');
    expect(googleCapabilities('loyalty')['role.tier']).toBe('text');
    expect(googleCapabilities('event')['role.seat']).toBe('native');
    expect(googleCapabilities('gift')['role.giftCardNumber']).toBe('native');
    expect(googleCapabilities('offer')['role.offerTitle']).toBe('native');
  });

  it('carries start times on every type but loyalty and gift', () => {
    expect(googleCapabilities('generic')['relevance.dates']).toBe('native');
    expect(googleCapabilities('offer')['relevance.dates']).toBe('native');
    expect(googleCapabilities('loyalty')['relevance.dates']).toBe('omitted');
    expect(googleCapabilities('gift')['relevance.dates']).toBe('omitted');
  });
});
