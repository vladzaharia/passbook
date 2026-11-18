import { describe, expect, it } from 'vitest';
import { sampleDoc } from '../templates/designer/fixtures.ts';
import { brandDoc, choicesOf } from './quick-setup.ts';

const withInputs = () => {
  const doc = sampleDoc();
  const inputs = doc.manifest.inputs as { properties: Record<string, unknown> };
  inputs.properties.currency = {
    type: 'string',
    enum: ['USD', 'EUR'],
    default: 'USD',
    'x-enumLabels': { USD: 'US dollar' },
  };
  inputs.properties.stamps = { type: 'integer', maximum: 19 };
  doc.manifest.stamps = { input: 'stamps', goal: 10, art: {} };
  doc.manifest.sample = { ...(doc.manifest.sample as object), currency: 'USD', stamps: 3 };
  return doc;
};

describe('quick setup choices', () => {
  it('offers the goal and the currency a blueprint has, defaulting to its own', () => {
    expect(choicesOf(sampleDoc())).toEqual({});
    const c = choicesOf(withInputs());
    expect(c.goal).toMatchObject({ value: 10 });
    expect(c.currency?.value).toBe('USD');
    expect(c.currency?.options).toEqual(expect.arrayContaining(['USD', 'EUR', 'CAD']));
  });

  it('limits the codes to the input pattern', () => {
    const doc = withInputs();
    const node = (doc.manifest.inputs as { properties: { currency: Record<string, unknown> } })
      .properties.currency;
    node.pattern = '^(USD|CAD)$';
    expect(choicesOf(doc).currency?.options).toEqual(['USD', 'CAD']);
    expect(
      (
        brandDoc(doc, { name: 'X', currency: 'EUR' }).manifest.inputs as {
          properties: { currency: { default: string } };
        }
      ).properties.currency.default,
    ).toBe('USD');
  });

  it('applies the goal and the currency to the draft', () => {
    const out = brandDoc(withInputs(), { name: 'Gym', goal: 8, currency: 'CAD' });
    expect(out.manifest.stamps).toMatchObject({ goal: 8 });
    const node = (out.manifest.inputs as { properties: Record<string, Record<string, unknown>> })
      .properties;
    expect(node.stamps?.maximum).toBe(15);
    expect(node.currency).toMatchObject({ default: 'CAD', enum: ['USD', 'EUR', 'CAD'] });
    expect((node.currency?.['x-enumLabels'] as Record<string, string> | undefined)?.CAD).toBe(
      'CAD',
    );
    expect((out.manifest.sample as Record<string, unknown>).currency).toBe('CAD');
  });
});
