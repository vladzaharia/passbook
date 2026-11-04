import { describe, expect, it } from 'vitest';
import { changedKeys } from './detail/fields-tab.tsx';
import { fitScale, requiredSize, usedSlots } from './detail/image-slots.ts';
import { fingerprint } from './format.ts';
import { actionsFor } from './pass-actions.tsx';
import { assetMap, viewTarget } from './pass-preview.tsx';
import { assetName, checkPng, MAX_ASSET_BYTES } from './png.ts';
import { cleanValues, pickDeclared, sameValues } from './schema-form/index.ts';
import { locationError, parseLocation } from './schema-form/location.ts';
import { passSummary } from './test-fixtures.ts';

function png(width: number, height: number, size = 33): File {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], 'x.png', { type: 'image/png' });
}

describe('checkPng', () => {
  it('reads dimensions from IHDR', async () => {
    expect(await checkPng(png(90, 120))).toEqual({ ok: true, width: 90, height: 120 });
  });
  it('rejects non-PNG bytes, empty dimensions, huge dimensions and big files', async () => {
    expect((await checkPng(new File(['hello world, not a png at all!!'], 'a.png'))).message).toBe(
      'Not a PNG file.',
    );
    expect((await checkPng(png(0, 10))).ok).toBe(false);
    expect((await checkPng(png(5000, 10))).ok).toBe(false);
    expect((await checkPng(png(10, 10, MAX_ASSET_BYTES + 1))).message).toMatch(/over 1 MB/);
  });
  it('names slots by scale', () => {
    expect(assetName('thumbnail', 1)).toBe('thumbnail.png');
    expect(assetName('thumbnail', 3)).toBe('thumbnail@3x.png');
  });
});

describe('draft helpers', () => {
  it('changedKeys reports edits, additions and clears (as null)', () => {
    expect(changedKeys({ a: 'x', b: 'y', c: 1 }, { a: 'x', b: 'z', d: true })).toEqual({
      b: 'z',
      c: null,
      d: true,
    });
  });
  it('treats empty strings as absent', () => {
    expect(sameValues({ a: '' }, {})).toBe(true);
    expect(cleanValues({ a: '', b: Number.NaN, c: 0, d: false })).toEqual({ c: 0, d: false });
  });
  it('pickDeclared drops keys the schema does not declare', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    expect(pickDeclared(schema, { a: 1, extra: 2 })).toEqual({ a: 1 });
  });
  it('fingerprint ignores key order', () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(fingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe('pass preview helpers', () => {
  it('maps the kit iOS toggle to the pass view target', () => {
    expect(viewTarget('27')).toBe('ios27');
    expect(viewTarget('legacy')).toBe('legacy');
  });
  it('assetMap enumerates real names, or every image slot when none are given', () => {
    const map = assetMap('/p/tok/assets/');
    expect(map['logo@2x.png']).toBe('/p/tok/assets/logo%402x.png');
    expect(Object.keys(map)).toContain('artwork.png');
    expect(Object.keys(map)).not.toContain('anything');
    expect(assetMap('/a', ['strip.png', 'en.lproj/logo.png'])).toEqual({
      'strip.png': '/a/strip.png',
      'en.lproj/logo.png': '/a/en.lproj%2Flogo.png',
    });
  });
});

describe('pass actions', () => {
  const ids = (p: Parameters<typeof actionsFor>[0]) => actionsFor(p).map((a) => a.id);
  it('puts the state change first and destructive actions last', () => {
    const manual = passSummary({ holderState: 'waiting' }) as Parameters<typeof actionsFor>[0];
    expect(ids(manual)).toEqual([
      'update',
      'void',
      'open',
      'rotate',
      'download',
      'copy',
      'remove',
      'clear',
      'delete',
    ]);
    const bound = { ...manual, connectionId: 'c1' };
    expect(ids(bound)[0]).toBe('pull');
  });
  it('offers only Restore in the bar of a removed pass, with no Void, Update or Pull', () => {
    const removed = {
      ...(passSummary() as Parameters<typeof actionsFor>[0]),
      status: 'voided' as const,
      removedAt: 5,
    };
    const defs = actionsFor(removed);
    expect(defs.filter((d) => d.bar).map((d) => d.id)).toEqual(['restore']);
    const all = defs.map((d) => d.id);
    for (const gone of ['void', 'unvoid', 'update', 'pull', 'remove'])
      expect(all).not.toContain(gone);
  });
  it('offers only Unvoid in the bar of a voided pass and never Update or Pull', () => {
    const voided = {
      ...(passSummary() as Parameters<typeof actionsFor>[0]),
      status: 'voided' as const,
    };
    const defs = actionsFor(voided);
    expect(defs.filter((d) => d.bar).map((d) => d.id)).toEqual(['unvoid']);
    expect(defs.map((d) => d.id)).not.toContain('update');
  });
});

describe('image slots', () => {
  it('reads the scale from the size and names the expected size when nothing fits', () => {
    expect(fitScale('strip', 750, 288)).toEqual({ scale: 2 });
    expect(fitScale('strip', 1125, 432)).toEqual({ scale: 3 });
    const bad = fitScale('thumbnail', 600, 600);
    expect('error' in bad && bad.error).toContain('180 × 180 px');
    expect(requiredSize('artwork', 2)).toBe('716 × 896 px');
  });
  it('lists the slots the template ships for its style, plus icon and logo', () => {
    const poster = { preferredStyleSchemes: ['posterEventTicket', 'eventTicket'], eventTicket: {} };
    expect(usedSlots(poster, ['artwork@2x.png', 'icon@2x.png', 'secondaryLogo@2x.png'])).toEqual([
      'icon',
      'logo',
      'secondaryLogo',
      'artwork',
    ]);
    expect(usedSlots({ generic: {} }, ['thumbnail@2x.png'])).toEqual(['icon', 'logo', 'thumbnail']);
  });
});

describe('location field', () => {
  it('reads a pair, an Apple Maps link and a Google Maps link', () => {
    expect(parseLocation('47.6062, -122.3321')).toEqual({ lat: 47.6062, lng: -122.3321 });
    expect(parseLocation('https://maps.apple.com/?ll=47.6,-122.3&q=Pin')).toEqual({
      lat: 47.6,
      lng: -122.3,
    });
    expect(parseLocation('https://www.google.com/maps/@47.61,-122.33,15z')).toEqual({
      lat: 47.61,
      lng: -122.33,
    });
    expect(parseLocation('nowhere')).toBeUndefined();
  });
  it('rejects latitude past 90 and longitude past 180', () => {
    expect(locationError(parseLocation('95, 10'), '95, 10')).toBe(
      'Latitude must be from -90 to 90.',
    );
    expect(locationError(parseLocation('10, 190'), '10, 190')).toBe(
      'Longitude must be from -180 to 180.',
    );
  });
});
