import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EXAMPLE_IDS, personalize } from './ids.ts';
import { loadInputs } from './load.ts';
import { samplesFor } from './samples.ts';
import { buildSite } from './site.ts';

const root = resolve(import.meta.dirname, '../../../..');
const site = buildSite(loadInputs(root));
const op = (key: string, anchor: string) => {
  const found = site.pages.find((p) => p.key === key)?.ops.find((o) => o.anchor === anchor);
  if (!found) throw new Error(`${key}.${anchor} is missing`);
  return found;
};
const code = (key: string, anchor: string, lang: string) =>
  samplesFor(op(key, anchor), site.baseUrl).find((s) => s.lang === lang)?.code ?? '';

describe('snippets', () => {
  it('writes TypeScript through the SDK, with ids first and the body after', () => {
    const ts = code('passes', 'update', 'ts');
    expect(ts).toContain("import { PassBook } from '@passbook/sdk';");
    expect(ts).toContain(`pb.passes.update('${EXAMPLE_IDS.passId}', {`);
    expect(ts).toContain('process.env.PASSBOOK_KEY');
  });

  it('walks every page of a list and sends the cursor and page size as the API takes them', () => {
    expect(code('passes', 'list', 'ts')).toContain('for await (const item of pb.passes.list(');
    expect(code('passes', 'list', 'curl')).toContain('/api/v1/passes?limit=25');
  });

  it('never carries a key, personalized or not', () => {
    for (const page of site.pages)
      for (const o of page.ops)
        for (const s of samplesFor(o, site.baseUrl)) {
          expect(s.code, `${o.operationId} ${s.lang}`).not.toMatch(/\b(pb|wlt)_/);
          expect(s.code, `${o.operationId} ${s.lang}`).toContain('PASSBOOK_KEY');
        }
  });

  it('swaps the example ids for the reader and refuses a key as a value', () => {
    const own = { orgId: 'org-mine', templateId: 'tpl-mine' };
    const out = personalize(code('passes', 'create', 'curl'), own);
    expect(out).toContain('tpl-mine');
    expect(out).toContain('$PASSBOOK_KEY');
    expect(out).not.toContain(EXAMPLE_IDS.templateId);
    expect(() => personalize('x', { orgId: 'wlt_abc_secret' })).toThrow();
  });

  it('lists the hand-written snippets under the operations they use', () => {
    expect(op('passes', 'create').examples.map((e) => e.id)).toContain('create-pass');
    expect(op('passes', 'create').examples[0]?.curl).toContain('curl -X POST');
  });
});
