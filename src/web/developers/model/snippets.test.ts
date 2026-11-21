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
const SDKS = { typescript: true, python: true, go: true };
const PLAIN = { typescript: false, python: false, go: false };
const code = (key: string, anchor: string, lang: string, sdk = SDKS) =>
  samplesFor(op(key, anchor), site.baseUrl, sdk).find((s) => s.lang === lang)?.code ?? '';

describe('snippets', () => {
  it('writes TypeScript through the SDK, with ids first and the body after', () => {
    const ts = code('passes', 'update', 'ts');
    expect(ts).toContain("import { PassBook } from '@passbook/sdk';");
    expect(ts).toContain(`pb.passes.update('${EXAMPLE_IDS.passId}', {`);
    expect(ts).toContain('process.env.PASSBOOK_KEY');
  });

  it('writes plain HTTP while an SDK is unpublished, and never names a package', () => {
    const update = (lang: string) => code('passes', 'update', lang, PLAIN);
    expect(update('ts')).toContain(`fetch('${site.baseUrl}/api/v1/passes/${EXAMPLE_IDS.passId}'`);
    expect(update('py')).toContain('import requests');
    expect(update('go')).toContain('net/http');
    for (const lang of ['ts', 'py', 'go'])
      expect(update(lang), lang).not.toMatch(/@passbook\/sdk|from passbook|vladzaharia/);
  });

  it('switches each language on its own flag', () => {
    const mixed = { typescript: true, python: false, go: false };
    expect(code('passes', 'update', 'ts', mixed)).toContain('@passbook/sdk');
    expect(code('passes', 'update', 'py', mixed)).toContain('requests');
  });

  it('walks every page of a list and sends the cursor and page size as the API takes them', () => {
    expect(code('passes', 'list', 'ts')).toContain('for await (const item of pb.passes.list(');
    expect(code('passes', 'list', 'curl')).toContain('/api/v1/passes?limit=25');
  });

  it('never carries a key, personalized or not', () => {
    for (const flags of [SDKS, PLAIN])
      for (const page of site.pages)
        for (const o of page.ops)
          for (const s of samplesFor(o, site.baseUrl, flags)) {
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
