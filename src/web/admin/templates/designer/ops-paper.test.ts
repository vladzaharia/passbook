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
});
