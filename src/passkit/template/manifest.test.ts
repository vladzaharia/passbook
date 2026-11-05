import { describe, expect, it } from 'vitest';
import { createBehaviorRegistry } from '../behaviors/registry.ts';
import venueLocations from '../behaviors/venue-locations/index.ts';
import type { PassJson, TemplateManifest } from '../types.ts';
import { applyDefaults, checkInput, projectDisplay, validateManifest } from './manifest.ts';

const base: TemplateManifest = {
  schema: 1,
  name: 'T',
  inputs: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 20 },
      tier: { type: 'string', enum: ['a', 'b'], default: 'a' },
      id: { type: 'string', pattern: '^[A-Z]+$' },
    },
  },
  sample: { name: 'Alex' },
  lookups: { tiers: { a: { label: 'Alpha' } } },
  bindings: [{ to: { field: 'name' }, value: '{{name}}' }],
  display: { title: '{{name}}', subtitle: '{{lookups.tiers[tier].label}}', search: ['name', 'id'] },
};

const codes = (m: TemplateManifest, o = {}) => validateManifest(m, o).map((i) => i.code);

describe('validateManifest', () => {
  it('accepts a sound manifest', () => {
    expect(validateManifest(base, { allowPattern: true })).toEqual([]);
  });

  it('rejects ReDoS-prone keywords unless baked', () => {
    expect(codes(base)).toEqual(['SCHEMA_KEYWORD']);
    expect(codes(base, { allowPattern: true })).toEqual([]);
    const nested = {
      ...base,
      inputs: {
        type: 'object',
        properties: { a: { type: 'array', items: { patternProperties: { '^a': {} } } } },
      },
    } as TemplateManifest;
    expect(codes(nested, { allowPattern: true })).toContain('SCHEMA_KEYWORD');
  });

  it('allows a property that is merely named "pattern"', () => {
    const m = {
      ...base,
      inputs: { type: 'object', properties: { pattern: { type: 'string' } } },
      sample: {},
      bindings: [],
      display: { title: 'x' },
    } as TemplateManifest;
    expect(codes(m)).toEqual([]);
  });

  it('rejects remote refs and format regex', () => {
    const m = {
      ...base,
      inputs: {
        type: 'object',
        properties: { a: { $ref: 'https://x.test/s' }, b: { type: 'string', format: 'regex' } },
      },
      sample: {},
    } as TemplateManifest;
    expect(codes(m).filter((c) => c === 'SCHEMA_KEYWORD')).toHaveLength(2);
  });

  it('reports a sample that does not satisfy the schema', () => {
    expect(codes({ ...base, sample: {} }, { allowPattern: true })).toContain('SAMPLE_INVALID');
  });

  it('reports expression syntax errors and unknown names', () => {
    const m = {
      ...base,
      bindings: [
        { to: { field: 'name' }, value: '{{name' },
        { to: { field: 'name' }, value: '{{nope}}' },
        { to: { field: 'name' }, value: '{{lookups.missing[tier].x}}' },
      ],
    } as TemplateManifest;
    const found = codes(m, { allowPattern: true });
    expect(found).toContain('EXPR');
    expect(found).toContain('EXPR_INPUT');
    expect(found).toContain('EXPR_LOOKUP');
  });

  it('checks targets against pass.json and pointers against the allowlist', () => {
    const passJson = {
      generic: { primaryFields: [{ key: 'name', value: '' }] },
      featuredActions: [{ identifier: 'site', type: 'url', url: 'https://x.test' }],
    } as unknown as PassJson;
    const m = {
      ...base,
      bindings: [
        { to: { field: 'ghost' }, value: 'x' },
        { to: { action: 'ghost', prop: 'url' }, value: 'x' },
        { to: { pointer: '/serialNumber' }, value: 'x' },
        { to: { pointer: '/expirationDate' }, value: '{{name}}' },
        { to: { pointer: 'nope' }, value: 'x' },
      ],
    } as TemplateManifest;
    const issues = validateManifest(m, { allowPattern: true, passJson });
    expect(issues.filter((i) => i.code === 'BINDING_TARGET')).toHaveLength(2);
    expect(issues.filter((i) => i.code === 'BINDING_POINTER')).toHaveLength(2);
  });

  it('checks behaviors against the registry and their config schema', () => {
    const behaviors = createBehaviorRegistry([venueLocations as never]);
    const m = (use: string, config: unknown) =>
      ({ ...base, behaviors: [{ use, version: 1, config }] }) as TemplateManifest;
    const opts = { allowPattern: true, behaviors };
    expect(codes(m('nope', {}), opts)).toContain('BEHAVIOR');
    expect(codes(m('venue-locations', {}), opts)).toContain('BEHAVIOR_CONFIG');
    expect(codes(m('venue-locations', { venues: 'tiers' }), opts)).toEqual([]);
    expect(codes(m('venue-locations', { venues: 'tiers', maxDistance: 0 }), opts)).toContain(
      'BEHAVIOR_CONFIG',
    );
  });

  it('warns about previewOnlyAssets that do not exist', () => {
    const m = { ...base, previewOnlyAssets: ['background.png'] };
    expect(codes(m, { allowPattern: true, assetNames: ['icon.png'] })).toContain('PREVIEW_ASSET');
  });
});

describe('messaging', () => {
  const passJson = (changeMessage?: string): PassJson =>
    ({
      generic: {
        backFields: [
          { key: 'name', label: 'Name', value: 'x', ...(changeMessage ? { changeMessage } : {}) },
        ],
      },
    }) as unknown as PassJson;
  const opts = { allowPattern: true };

  it('accepts an input bound to a "%@" back field', () => {
    const m = { ...base, messaging: { input: 'name' } };
    expect(codes(m, { ...opts, passJson: passJson('%@') })).toEqual([]);
  });

  it('rejects an unknown input', () => {
    const m = { ...base, messaging: { input: 'nope' } };
    expect(codes(m, opts)).toEqual(['MESSAGING_INPUT']);
  });

  it('rejects an input whose field has no "%@" message', () => {
    const m = { ...base, messaging: { input: 'name' } };
    expect(codes(m, { ...opts, passJson: passJson() })).toEqual(['MESSAGING_FIELD']);
    expect(codes(m, { ...opts, passJson: passJson('Now %@') })).toEqual(['MESSAGING_FIELD']);
  });

  it('rejects an input no binding reaches the field with', () => {
    const m = { ...base, messaging: { input: 'tier' } };
    expect(codes(m, { ...opts, passJson: passJson('%@') })).toEqual(['MESSAGING_FIELD']);
  });
});

describe('inputs and display', () => {
  it('applies defaults without mutating the input', () => {
    const input = { name: 'A' };
    expect(applyDefaults(base, input)).toEqual({ name: 'A', tier: 'a' });
    expect(input).toEqual({ name: 'A' });
  });

  it('validates after defaults and reports paths', () => {
    expect(checkInput(base, { name: 'A' })).toEqual([]);
    const issues = checkInput(base, { name: '', tier: 'z' });
    expect(issues.map((i) => i.path).sort()).toEqual(['name', 'tier']);
  });

  it('projects display fields and search text', () => {
    expect(projectDisplay(base, { name: 'Alex', id: 'AB' })).toEqual({
      title: 'Alex',
      subtitle: 'Alpha',
      status: null,
      search: 'alex ab',
    });
  });
});

describe('x-pattern-message', () => {
  const phone = {
    ...base,
    inputs: {
      ...base.inputs,
      properties: {
        ...base.inputs.properties,
        phone: { type: 'string', pattern: '^\\+[0-9]+$', 'x-pattern-message': 'Use +14155550100.' },
      },
    },
  } as TemplateManifest;
  it('replaces the generic pattern error with the schema words', () => {
    expect(checkInput(phone, { name: 'A', phone: '555' })).toMatchObject([
      { path: 'phone', message: 'Use +14155550100.' },
    ]);
    expect(checkInput(phone, { name: 'A', phone: '+1555' })).toEqual([]);
  });
});
