import { describe, expect, it } from 'vitest';
import { contrast, contrastWarnings, parseColor, toHex, toRgbText } from './contrast.ts';
import { slotNeeds } from '../../passes/detail/image-slots.ts';
import { clearDraft, loadDraft, saveDraft } from './drafts.ts';
import { sampleDoc } from './fixtures.ts';
import { assetsPayload, placeImage, previewAssetMap, readPng } from './images.ts';
import { issueTarget } from './targets.ts';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

describe('colors', () => {
  it('reads rgb() and hex, and writes both back', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual({ r: 1, g: 2, b: 3 });
    expect(parseColor('#0af')).toEqual({ r: 0, g: 170, b: 255 });
    expect(parseColor('rgb(300,0,0)')).toBeUndefined();
    expect(parseColor('red')).toBeUndefined();
    expect(toHex({ r: 1, g: 2, b: 3 })).toBe('#010203');
    expect(toRgbText({ r: 1, g: 2, b: 3 })).toBe('rgb(1,2,3)');
  });

  it('computes WCAG ratios and warns below 4.5:1', () => {
    expect(contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 })).toBeCloseTo(21, 0);
    expect(contrastWarnings({ backgroundColor: '#000000', foregroundColor: '#ffffff' })).toEqual(
      [],
    );
    const warned = contrastWarnings({
      backgroundColor: 'rgb(20,30,60)',
      foregroundColor: 'rgb(30,40,70)',
      labelColor: 'rgb(255,255,255)',
    });
    expect(warned.map((w) => w.key)).toEqual(['foregroundColor']);
    expect(warned[0]?.message).toMatch(/^Text contrast is 1\.\d:1; use at least 4\.5:1\.$/);
    // Labels are held to 3:1, as the server does.
    expect(
      contrastWarnings({ backgroundColor: '#ffffff', labelColor: '#777777' }).map((w) => w.key),
    ).toEqual([]);
    expect(contrastWarnings({ foregroundColor: '#fff' })).toEqual([]);
  });
});

describe('images', () => {
  it('reads the size of a PNG and refuses anything else', () => {
    expect(readPng(png(114, 114))).toEqual({ width: 114, height: 114 });
    expect(readPng(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it('picks @3x or @2x from the pixel size', () => {
    expect(placeImage('icon', png(114, 114))).toMatchObject({
      ok: true,
      asset: { name: 'icon@3x.png', scale: 3 },
    });
    expect(placeImage('icon', png(76, 76))).toMatchObject({
      ok: true,
      asset: { name: 'icon@2x.png', scale: 2 },
    });
    expect(placeImage('logo', png(300, 90))).toMatchObject({
      ok: true,
      asset: { name: 'logo@3x.png' },
    });
    const wrong = placeImage('icon', png(500, 500));
    expect(wrong.ok).toBe(false);
    expect(placeImage('icon', new Uint8Array(40)).ok).toBe(false);
  });

  it('warns about a soft image instead of refusing it', () => {
    const soft = placeImage('logo', png(60, 20));
    expect(soft.ok && soft.warning).toMatch(/smaller/);
  });

  it('says the size of each slot the same way as the pass Images tab', () => {
    expect(slotNeeds('icon')).toBe('needs 76 × 76 px (@2x) or 114 × 114 px (@3x)');
    expect(slotNeeds('logo')).toMatch(/^needs up to 320 × 100 px \(@2x\)/);
  });

  it('sends saved files by hash and new ones as uploads', () => {
    expect(
      assetsPayload([
        { name: 'a.png', slot: 'icon', scale: 3, size: 1, sha1: 'h' },
        { name: 'b.png', slot: 'logo', scale: 3, size: 1, upload: 'QQ==' },
      ]),
    ).toEqual([
      { name: 'a.png', sha1: 'h' },
      { name: 'b.png', upload: 'QQ==' },
    ]);
    expect(
      previewAssetMap(
        [
          { name: 'a@3x.png', slot: 'icon', scale: 3, size: 1, sha1: 'h' },
          { name: 'b.png', slot: 'logo', scale: 3, size: 1, upload: 'QQ==' },
          { name: 'pass.strings', slot: 'strings', scale: 1, size: 1, sha1: 'x' },
        ],
        '/base/',
      ),
    ).toEqual({ 'a@3x.png': '/base/a%403x.png', 'b.png': 'data:image/png;base64,QQ==' });
  });
});

describe('issue targets', () => {
  const doc = sampleDoc();
  it('maps paths to the part of the designer they are about', () => {
    const at = (path: string, code = 'X') =>
      issueTarget({ severity: 'error', code, message: 'm', path }, doc);
    expect(at('generic.secondaryFields[1].value')).toEqual({
      section: 'secondaryFields',
      key: 'since',
    });
    expect(at('barcodes[0].format')).toEqual({ section: 'barcode' });
    expect(at('backgroundColor')).toEqual({ section: 'colors' });
    expect(at('locations[0].latitude')).toEqual({ section: 'relevance' });
    expect(at('logoText')).toEqual({ section: 'style' });
    expect(at('icon@2x.png')).toEqual({ section: 'images', key: 'icon' });
    expect(at('en.lproj/logo.png')).toEqual({ section: 'images', key: 'logo' });
    expect(at('inputs/properties/name/pattern')).toEqual({ section: 'inputs', key: 'name' });
    expect(at('sample/name')).toEqual({ section: 'inputs', key: 'name' });
    expect(at('bindings/0/value')).toEqual({ section: 'primaryFields', key: 'name' });
    expect(at('display/title')).toEqual({ section: 'inputs' });
    expect(at('', 'MISSING_ICON')).toEqual({ section: 'images', key: 'icon' });
    expect(at('somewhere.else')).toBeNull();
    expect(at('generic.footerFields[0]')).toBeNull();
  });
});

describe('drafts', () => {
  it('round-trips through storage and clears', () => {
    const doc = sampleDoc();
    if (!saveDraft('t1', { base: 'v1', doc, at: 1 })) return;
    expect(loadDraft('t1')?.doc.manifest).toEqual(doc.manifest);
    clearDraft('t1');
    expect(loadDraft('t1')).toBeNull();
  });

  it('refuses a draft that is too large', () => {
    const doc = sampleDoc();
    doc.assets = [
      { name: 'a.png', slot: 'logo', scale: 3, size: 1, upload: 'A'.repeat(3_000_000) },
    ];
    expect(saveDraft('t2', { base: 'v1', doc, at: 1 })).toBe(false);
  });
});
