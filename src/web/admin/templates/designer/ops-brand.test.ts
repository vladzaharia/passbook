import { describe, expect, it } from 'vitest';
import { applyOp } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { ownParts, setBrandPart } from './ops-brand.ts';

describe('brand block ops', () => {
  it('a template starts following the organization, with no block', () => {
    expect(ownParts(sampleDoc())).toEqual([]);
    expect('brand' in sampleDoc().manifest).toBe(false);
  });

  it('keeps a part for the template, in a stable order', () => {
    const doc = applyOp(applyOp(sampleDoc(), { op: 'brand', part: 'logo', own: true }), {
      op: 'brand',
      part: 'colors',
      own: true,
    });
    expect(doc.manifest.brand).toEqual({ colors: 'template', logo: 'template' });
    expect(ownParts(doc)).toEqual(['colors', 'logo']);
  });

  it('follows the organization again and drops the empty block', () => {
    const own = setBrandPart(sampleDoc(), 'icon', true);
    const back = setBrandPart(own, 'icon', false);
    expect('brand' in back.manifest).toBe(false);
  });

  it('is the same document when nothing changes', () => {
    const doc = sampleDoc();
    expect(setBrandPart(doc, 'logo', false)).toBe(doc);
    const own = setBrandPart(doc, 'logo', true);
    expect(setBrandPart(own, 'logo', true)).toBe(own);
  });
});
