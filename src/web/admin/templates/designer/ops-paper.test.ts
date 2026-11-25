import { describe, expect, it } from 'vitest';
import { paperManifestIssues } from '@/passkit/template/paper.ts';
import { EVENT_MANIFEST, EVENT_PASS } from '@/passkit/template/paper-fixtures.ts';
import type { TemplateManifest } from '@/passkit/types.ts';
import { applyOp } from './apply.ts';
import type { DesignDoc } from './model.ts';

const doc = (): DesignDoc => ({
  passJson: structuredClone(EVENT_PASS) as unknown as DesignDoc['passJson'],
  manifest: structuredClone(EVENT_MANIFEST) as unknown as DesignDoc['manifest'],
  assets: [],
});
const issues = (d: DesignDoc) =>
  paperManifestIssues(d.manifest as unknown as TemplateManifest, { passJson: d.passJson });

describe('paper op', () => {
  it('starts a block from the defaults, merges later patches and keeps it valid', () => {
    let d = applyOp(doc(), { op: 'paper', patch: { size: 'letter' } });
    expect(d.manifest.paper).toEqual({ schema: 1, size: 'letter', barcode: 'qr' });
    d = applyOp(d, {
      op: 'paper',
      patch: { barcode: 'code128', fields: ['level'], terms: '{{terms}}' },
    });
    d = applyOp(d, { op: 'paper', patch: { holder: false } });
    expect(d.manifest.paper).toEqual({
      schema: 1,
      size: 'letter',
      barcode: 'code128',
      fields: ['level'],
      terms: '{{terms}}',
      holder: false,
    });
    expect(issues(d)).toEqual([]);
  });

  it('drops empty fields, terms and holder true, and the whole block on null', () => {
    let d = applyOp(doc(), {
      op: 'paper',
      patch: { size: 'a4', fields: ['level'], holder: false },
    });
    d = applyOp(d, { op: 'paper', patch: { fields: [], terms: '  ', holder: true } });
    expect(d.manifest.paper).toEqual({ schema: 1, size: 'a4', barcode: 'qr' });
    expect(applyOp(d, { op: 'paper', patch: null }).manifest).not.toHaveProperty('paper');
  });

  it('reports the same problems paper.ts does', () => {
    const d = applyOp(doc(), { op: 'paper', patch: { fields: ['order'] } });
    expect(issues(d).map((i) => i.code)).toEqual(['PAPER_LOOKUP_FIELD']);
  });

  it('writes kind, mono ink, the buddy, fold marks off and bring, and drops them when reset', () => {
    let d = applyOp(doc(), {
      op: 'paper',
      patch: {
        size: 'a4',
        kind: 'permit',
        ink: 'mono',
        buddy: true,
        fold: false,
        bring: 'Water\nHat',
      },
    });
    expect(d.manifest.paper).toEqual({
      schema: 1,
      size: 'a4',
      barcode: 'qr',
      kind: 'permit',
      ink: 'mono',
      fold: false,
      bring: 'Water\nHat',
      buddy: true,
    });
    expect(issues(d)).toEqual([]);
    d = applyOp(d, {
      op: 'paper',
      patch: { kind: null, ink: 'colour', buddy: false, fold: true, bring: '  ' },
    });
    expect(d.manifest.paper).toEqual({ schema: 1, size: 'a4', barcode: 'qr' });
  });

  it('ticking "Holders can print" on an ID kind writes holder true, explicit or derived', () => {
    const explicit = applyOp(doc(), {
      op: 'paper',
      patch: { kind: 'badge', holder: true, effectiveKind: 'badge' },
    });
    expect((explicit.manifest.paper as { holder?: boolean }).holder).toBe(true);
    // A derived ID has no `kind`: the effective class says what the default is.
    const started = applyOp(doc(), { op: 'paper', patch: { size: 'cr80' } });
    const derived = applyOp(started, {
      op: 'paper',
      patch: { holder: true, effectiveKind: 'badge' },
    });
    expect((derived.manifest.paper as { holder?: boolean }).holder).toBe(true);
    // Back to the default is not written.
    const closed = applyOp(derived, {
      op: 'paper',
      patch: { holder: false, effectiveKind: 'badge' },
    });
    expect(closed.manifest.paper).not.toHaveProperty('holder');
  });

  it('keeps an explicit holder: false through admission, badge and admission again', () => {
    let d = applyOp(doc(), { op: 'paper', patch: { kind: 'admission', holder: false } });
    expect((d.manifest.paper as { holder?: boolean }).holder).toBe(false);
    d = applyOp(d, { op: 'paper', patch: { kind: 'badge' } });
    expect((d.manifest.paper as { holder?: boolean }).holder).toBe(false);
    d = applyOp(d, { op: 'paper', patch: { kind: 'admission' } });
    expect((d.manifest.paper as { holder?: boolean }).holder).toBe(false);
  });
});
