import { describe, expect, it } from 'vitest';
import { PASS_STYLES } from '@/passkit/types.ts';
import { resolveStyles } from '../../../../passkit/schema/validate-top.ts';
import { applyOp, type Op } from './apply.ts';
import { sampleDoc } from './fixtures.ts';
import { type DesignDoc, fieldsOf, hasBothFaces, keyOf, legacyStyleOf } from './model.ts';

const run = (doc: DesignDoc, ...ops: Op[]) => ops.reduce(applyOp, doc);
const codes = (doc: DesignDoc): string[] => {
  const out: string[] = [];
  const report = (code: string) => out.push(code);
  resolveStyles(doc.passJson as never, report, report);
  return out;
};

describe('poster layout on Generic', () => {
  it('on: posterGeneric appears next to generic, seeded and within the poster limits', () => {
    const doc = run(sampleDoc(), { op: 'poster', on: true });
    expect(doc.passJson.generic).toBeDefined();
    expect(hasBothFaces(doc.passJson)).toBe(true);
    const poster = doc.passJson.posterGeneric as Record<string, { key: string }[]>;
    expect(poster.primaryFields?.map((f) => f.key)).toEqual(['name']);
    expect(poster.additionalInfoFields?.map((f) => f.key)).toEqual(['tier', 'since']);
    expect(poster.backFields?.map((f) => f.key)).toEqual(['terms']);
    expect(codes(doc)).not.toContain('POSTER_FALLBACK');
  });

  it('off removes posterGeneric and keeps generic', () => {
    const doc = run(sampleDoc(), { op: 'poster', on: true }, { op: 'poster', on: false });
    expect(doc.passJson.posterGeneric).toBeUndefined();
    expect(doc.passJson.generic).toBeDefined();
  });

  it('switching style away drops posterGeneric', () => {
    const doc = run(sampleDoc(), { op: 'poster', on: true }, { op: 'style', style: 'coupon' });
    expect(doc.passJson.posterGeneric).toBeUndefined();
    expect(doc.passJson.coupon).toBeDefined();
  });

  it('edits follow the target', () => {
    const doc = run(
      sampleDoc(),
      { op: 'poster', on: true },
      { op: 'target', target: 'poster' },
      { op: 'field-add', group: 'footerFields', key: 'foot' },
    );
    expect(fieldsOf(doc.passJson, 'footerFields', 'poster').map(keyOf)).toEqual(['foot']);
    expect((doc.passJson.generic as Record<string, unknown>).footerFields).toBeUndefined();
  });

  it('repairs a draft with posterGeneric alone, only on request', () => {
    const base = sampleDoc();
    const lone: DesignDoc = {
      ...base,
      passJson: {
        ...base.passJson,
        generic: undefined,
        posterGeneric: { primaryFields: [{ key: 'a', label: 'A', value: '1' }] },
      },
    };
    delete lone.passJson.generic;
    expect(legacyStyleOf(lone.passJson)).toBe('generic');
    expect(codes(lone)).toContain('POSTER_FALLBACK');
    const fixed = run(lone, { op: 'poster-repair' });
    expect(codes(fixed)).not.toContain('POSTER_FALLBACK');
    expect(fieldsOf(fixed.passJson, 'primaryFields', 'legacy').map(keyOf)).toEqual(['a']);
  });

  it('no sequence of style picks leaves a lone posterGeneric', () => {
    for (const from of PASS_STYLES) {
      for (const to of PASS_STYLES) {
        const doc = run(
          sampleDoc(),
          { op: 'style', style: from },
          { op: 'poster', on: true },
          { op: 'style', style: to },
        );
        if (doc.passJson.posterGeneric !== undefined) {
          expect(
            Object.keys(doc.passJson).filter((k) => PASS_STYLES.includes(k as never)).length,
          ).toBeGreaterThan(1);
        }
      }
    }
  });
});
