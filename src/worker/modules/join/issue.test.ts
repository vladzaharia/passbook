import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { ManualClock } from '../../platform/clock.ts';
import { createIds } from '../../platform/ids.ts';
import { assembleInput, type OpenRelease } from './issue.ts';
import { joinReadiness } from './readiness.ts';

const ids = createIds(new ManualClock(1_700_000_000_000));

function open(manifest: TemplateManifest, nameInput: string | null): OpenRelease {
  return {
    version: 'v1',
    readiness: joinReadiness(manifest, nameInput),
    template: { manifest } as unknown as ResolvedTemplate,
  };
}

const stamp = (): TemplateManifest => {
  const baked = bakedTemplates.find((t) => t.slug === 'starter-stamp-card');
  if (!baked) throw new Error('missing blueprint');
  const m = structuredClone(baked.manifest);
  for (const b of m.bindings) if ('barcode' in b.to) b.value = '{{pass.scanCode}}';
  m.scan = { actions: m.scan?.actions ?? [], lookup: { input: 'cardNumber' } };
  return m;
};

describe('assembleInput', () => {
  it('is the defaults, the name in its one input and a ten-digit value for a required input nobody asks', () => {
    const m = stamp();
    const input = assembleInput(open(m, 'holder'), 'Sam', ids);
    expect(input.holder).toBe('Sam');
    // Required, no default, not asked: generated, and 10 digits (ids.code stops short of that on its own).
    expect(input.cardNumber).toMatch(/^[0-9]{10}$/);
    // Defaults only; nothing from the template's sample reaches the card.
    for (const key of Object.keys(m.sample))
      if (key !== 'holder' && key !== 'cardNumber') {
        const schema = (m.inputs.properties as Record<string, { default?: unknown }>)[key];
        expect(input[key] === undefined || input[key] === schema?.default).toBe(true);
      }
    expect(
      new Set(
        Array.from({ length: 20 }, () => assembleInput(open(m, 'holder'), 'S', ids).cardNumber),
      ).size,
    ).toBeGreaterThan(15);
  });

  it('never puts the name on the lookup, stamps or messaging inputs', () => {
    const m = stamp();
    // A link that names the lookup input as its name input asks nothing: the input is operator-owned.
    const o = open(m, 'cardNumber');
    expect(o.readiness.nameInput).toBeNull();
    const input = assembleInput(o, 'Sam', ids);
    expect(input.cardNumber).toMatch(/^[0-9]{10}$/);
    expect(input.cardNumber).not.toBe('Sam');
    for (const reserved of ['stamps', 'message'])
      expect(input[reserved] === undefined || input[reserved] !== 'Sam').toBe(true);
    expect(input.holder).not.toBe('Sam');
  });

  it('refuses an input the schema does not accept', () => {
    const m = stamp();
    expect(() => assembleInput(open(m, 'holder'), 'x'.repeat(81), ids)).toThrowError();
  });
});
