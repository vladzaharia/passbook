import { describe, expect, it } from 'vitest';
import { bakedTemplates } from '../../../generated/baked-templates.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { defaultNameInput, joinReadiness } from './readiness.ts';

const baked = bakedTemplates.find((t) => t.slug === 'starter-stamp-card');
if (!baked) throw new Error('The Stamp card blueprint is missing; run npm run gen.');

const stampCard = (): TemplateManifest => structuredClone(baked.manifest);

/** The stamp card as J6 leaves it: the barcode is the scan code and the card number is optional. */
const stampCardAfterJ6 = (): TemplateManifest => {
  const m = stampCard();
  for (const b of m.bindings) if ('barcode' in b.to) b.value = '{{pass.scanCode}}';
  m.inputs.required = ['holder'];
  return m;
};

const simple = (patch: (m: TemplateManifest) => void = () => {}): TemplateManifest => {
  const m: TemplateManifest = {
    schema: 1,
    name: 'Simple',
    inputs: {
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 60 } },
    },
    sample: { name: 'Sample Person' },
    bindings: [{ to: { barcode: '*', prop: 'message' }, value: '{{pass.scanCode}}' }],
    display: { title: '{{name}}' },
  };
  patch(m);
  return m;
};

describe('join readiness', () => {
  it('a stamp card before J6 reads its barcode from the card number', () => {
    const r = joinReadiness(stampCard(), 'holder');
    expect(r.issues).toEqual([
      { code: 'barcode_input', input: 'cardNumber', label: 'Card number' },
    ]);
  });

  it('a stamp card after J6 is ready; the name fills Holder and nothing is generated', () => {
    const r = joinReadiness(stampCardAfterJ6(), 'holder');
    expect(r.issues).toEqual([]);
    expect(r.nameInput).toBe('holder');
    expect(r.generated).toEqual([]);
    expect(defaultNameInput(stampCardAfterJ6())).toBe('holder');
  });

  it('keeps the lookup, stamps and messaging inputs out of the name choices', () => {
    const m = stampCardAfterJ6();
    m.scan = { actions: [], lookup: { input: 'cardNumber' } };
    const r = joinReadiness(m, null);
    const keys = r.nameInputs.map((i) => i.key);
    expect(keys).toContain('holder');
    expect(keys).not.toContain('cardNumber');
    expect(keys).not.toContain('stamps');
    expect(keys).not.toContain('message');
    expect(keys).not.toContain('website');
  });

  it('a required number with no default needs the designer', () => {
    const m = simple((x) => {
      x.inputs.required = ['name', 'tier'];
      (x.inputs.properties as Record<string, unknown>).tier = {
        type: 'integer',
        'x-label': 'Tier',
      };
    });
    expect(joinReadiness(m, 'name').issues).toEqual([
      { code: 'input_needed', input: 'tier', label: 'Tier' },
    ]);
  });

  it('a required string nobody asks for is generated as ten digits', () => {
    const m = simple((x) => {
      x.inputs.required = ['name', 'cardNumber'];
      (x.inputs.properties as Record<string, unknown>).cardNumber = {
        type: 'string',
        'x-label': 'Card number',
        maxLength: 64,
      };
    });
    const r = joinReadiness(m, 'name');
    expect(r.issues).toEqual([]);
    expect(r.generated).toEqual([{ key: 'cardNumber', label: 'Card number' }]);
    // Not chosen as the name: the name input is then generated too.
    expect(joinReadiness(m, null).generated.map((i) => i.key)).toEqual(['cardNumber', 'name']);
  });

  it('a required string a ten-digit value cannot satisfy is not generated', () => {
    for (const schema of [
      { type: 'string', enum: ['a', 'b'] },
      { type: 'string', maxLength: 5 },
      { type: 'string', minLength: 12 },
      { type: 'string', pattern: '^[A-Z]+$' },
      { type: 'string', format: 'email' },
    ]) {
      const m = simple((x) => {
        x.inputs.required = ['name', 'code'];
        (x.inputs.properties as Record<string, unknown>).code = schema;
      });
      expect(joinReadiness(m, 'name').issues.map((i) => i.code)).toEqual(['input_needed']);
    }
  });

  it('a required input with a default needs nothing', () => {
    const m = simple((x) => {
      x.inputs.required = ['name', 'tier'];
      (x.inputs.properties as Record<string, unknown>).tier = { type: 'integer', default: 1 };
    });
    expect(joinReadiness(m, 'name').issues).toEqual([]);
  });

  it('refuses a barcode that is not the plain scan code', () => {
    const none = simple((x) => {
      x.bindings = [];
    });
    expect(joinReadiness(none, 'name').issues).toEqual([{ code: 'barcode_input' }]);
    const literal = simple((x) => {
      x.bindings = [{ to: { barcode: '*', prop: 'message' }, value: '12345' }];
    });
    expect(joinReadiness(literal, 'name').issues).toEqual([{ code: 'barcode_input' }]);
    const conditional = simple((x) => {
      x.bindings = [
        { to: { barcode: 0, prop: 'message' }, value: '{{pass.scanCode}}' },
        { to: { barcode: 0, prop: 'message' }, value: 'x', when: { input: 'name', eq: 'a' } },
      ];
    });
    expect(joinReadiness(conditional, 'name').issues.map((i) => i.code)).toEqual(['barcode_input']);
    const alt = simple((x) => {
      x.bindings.push({ to: { barcode: '*', prop: 'altText' }, value: '{{name}}' });
    });
    expect(joinReadiness(alt, 'name').issues).toEqual([
      { code: 'barcode_input', input: 'name', label: 'name' },
    ]);
  });

  it('a name input is a plain string of at least 20 characters', () => {
    const m = simple((x) => {
      const p = x.inputs.properties as Record<string, unknown>;
      p.short = { type: 'string', maxLength: 10 };
      p.url = { type: 'string', format: 'uri' };
      p.pick = { type: 'string', enum: ['a'] };
    });
    expect(joinReadiness(m, null).nameInputs.map((i) => i.key)).toEqual(['name']);
  });

  it('a pattern a leading zero fails is not generated', () => {
    const m = simple((x) => {
      x.inputs.required = ['name', 'code'];
      (x.inputs.properties as Record<string, unknown>).code = {
        type: 'string',
        pattern: '^[1-9][0-9]{9}$',
      };
    });
    expect(joinReadiness(m, 'name').issues.map((i) => i.code)).toEqual(['input_needed']);
  });

  it('allows the name only in a plain field value', () => {
    const base = (b: TemplateManifest['bindings'][number]) =>
      simple((x) => {
        x.bindings.push(b);
      });
    const refused = [
      { to: { pointer: '/nfc/message' }, value: '{{name}}' },
      { to: { action: 'go', prop: 'url' }, value: '{{name}}' },
      { to: { field: 'tier' }, value: 'Gold', when: { input: 'name', eq: 'gold' } },
      { to: { field: 'tier' }, value: 'x', remove: { input: 'name', eq: 'a' } },
      { to: { field: 'tier', prop: 'changeMessage' }, value: '{{name}}' },
      { to: { image: 'strip' }, value: '{{name}}' },
    ] as TemplateManifest['bindings'];
    for (const b of refused)
      expect(
        joinReadiness(base(b), null).nameInputs.map((i) => i.key),
        JSON.stringify(b),
      ).toEqual([]);
    const ok = { to: { field: 'tier' }, value: '{{name}}' } as TemplateManifest['bindings'][number];
    expect(joinReadiness(base(ok), null).nameInputs.map((i) => i.key)).toEqual(['name']);
  });
});
