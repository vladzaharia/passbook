import { describe, expect, it } from 'vitest';
import { changedKeys } from './detail/fields-tab.tsx';
import { fingerprint } from './format.ts';
import { assetMap, forTarget } from './pass-preview.tsx';
import { assetName, checkPng, MAX_ASSET_BYTES } from './png.ts';
import { cleanValues, pickDeclared, sameValues } from './schema-form/index.ts';

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
    expect((await checkPng(png(10, 10, MAX_ASSET_BYTES + 1))).message).toMatch(/Larger than/);
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
  it('forTarget drops the scheme list only for earlier iOS', () => {
    const json = { preferredStyleSchemes: ['posterGeneric', 'generic'], generic: {} };
    expect(forTarget(json, '27')).toBe(json);
    expect(forTarget(json, 'legacy')).toEqual({ generic: {} });
  });
  it('assetMap resolves any name under the base URL', () => {
    const map = assetMap('/p/tok/assets/');
    expect(map['logo@2x.png']).toBe('/p/tok/assets/logo%402x.png');
    expect('anything' in map).toBe(true);
  });
});
