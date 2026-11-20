import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { highlight } from './highlight.ts';
import { loadInputs } from './load.ts';
import { GROUP_ORDER, groupOf } from './resources.ts';
import { samplesFor } from './samples.ts';
import { buildSite } from './site.ts';

const root = resolve(import.meta.dirname, '../../../..');
const inputs = loadInputs(root);
const site = buildSite(inputs);

describe('portal model', () => {
  it('publishes the operations a key can call, one page per resource, none of the platform', () => {
    expect(site.opCount).toBeGreaterThan(100);
    expect(site.pages.length).toBeGreaterThan(10);
    for (const page of site.pages) {
      expect(page.ops.length, page.key).toBeGreaterThan(0);
      expect(GROUP_ORDER).toContain(groupOf(page.key));
    }
    expect(site.pages.map((p) => p.key)).not.toContain('platform');
    expect(new Set(site.pages.map((p) => p.slug)).size).toBe(site.pages.length);
  });

  it('anchors each operation by its SDK method, unique within the page', () => {
    const passes = site.pages.find((p) => p.key === 'passes');
    const anchors = passes?.ops.map((o) => o.anchor) ?? [];
    expect(anchors).toContain('create');
    expect(anchors).toContain('void');
    for (const page of site.pages) {
      const seen = page.ops.map((o) => o.anchor);
      expect(new Set(seen).size, page.key).toBe(seen.length);
    }
    const create = passes?.ops.find((o) => o.anchor === 'create');
    expect(create?.operationId).toBe('passes.postPasses');
    expect(create?.sdkCall).toBe('pb.passes.create');
    expect(create?.idempotent).toBe(true);
  });

  it('shows no x-codes table until the data exists, then reads status and fix from the catalog', () => {
    expect(site.pages.flatMap((p) => p.ops).every((o) => o.errors.length === 0)).toBe(true);
    const doc = structuredClone(inputs.doc);
    const op = doc.paths['/api/v1/passes']?.post;
    if (!op) throw new Error('POST /api/v1/passes is missing');
    op['x-codes'] = ['PASS_CONFLICT', { code: 'VALIDATION', status: 422 }];
    const withCodes = buildSite({
      ...inputs,
      doc,
      errors: [{ code: 'PASS_CONFLICT', status: 409 }],
      guide: { PASS_CONFLICT: { fix: 'Use another serial.' } },
    });
    const create = withCodes.pages
      .find((p) => p.key === 'passes')
      ?.ops.find((o) => o.anchor === 'create');
    expect(create?.errors).toEqual([
      { code: 'PASS_CONFLICT', status: 409, fix: 'Use another serial.' },
      { code: 'VALIDATION', status: 422, fix: '' },
    ]);
    expect(withCodes.errors.map((e) => e.code)).toEqual(['PASS_CONFLICT', 'VALIDATION']);
    expect(withCodes.errors[0]?.usedBy[0]).toMatchObject({ slug: 'passes', anchor: 'create' });
  });

  it('writes samples that read the key from the environment and never carry one', () => {
    const create = site.pages
      .find((p) => p.key === 'passes')
      ?.ops.find((o) => o.anchor === 'create');
    if (!create) throw new Error('create is missing');
    const samples = samplesFor(create, site.baseUrl);
    expect(samples.map((s) => s.lang)).toEqual(['curl', 'ts', 'py', 'go']);
    for (const s of samples) {
      expect(s.code, s.lang).toContain('PASSBOOK_KEY');
      expect(s.code, s.lang).not.toMatch(/pb_(live|test)_/);
      expect(s.code, s.lang).toContain('/api/v1/passes');
    }
  });

  it('escapes what it highlights', () => {
    const html = highlight('{"a": "<img src=x onerror=alert(1)>"}', 'json');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(highlight('curl -H "Authorization: Bearer $PASSBOOK_KEY"', 'curl')).toContain(
      '<span class="envchip">$PASSBOOK_KEY</span>',
    );
  });
});
