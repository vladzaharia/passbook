import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drift, generate, OUT, owns } from './gen-sdk-go.ts';
import { GoTypes, goName } from './lib/sdk-go-emit.ts';
import { Models } from './lib/sdk-model.ts';
import type { OpenApiDoc, SdkNames } from './lib/sdk-ts-ops.ts';

const root = resolve(import.meta.dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const doc = read<OpenApiDoc>('docs/api/openapi.v1.json');
const names = read<SdkNames>('docs/api/sdk-names.json');

describe('the committed Go SDK', () => {
  it('matches the generator (run `node tools/gen-sdk-go.ts` after changing the API)', () => {
    expect(drift(generate(doc, names), resolve(root, OUT), owns)).toEqual([]);
  });

  it('exposes every resource as a field and every method with a context', () => {
    const text = generate(doc, names).get('resources_gen.go') ?? '';
    expect(text).toContain(
      'func (r *PassesResource) Create(ctx context.Context, body *PassesCreateBody, opts ...RequestOption)',
    );
    expect(text).toContain('WebhookEndpoints');
    expect(text).toContain('func (r *PassesResource) Delete(ctx context.Context, id string');
    expect(text).toContain('*Pager[');
  });

  it('only touches the generated files of sdk/go', () => {
    expect(owns('types_gen.go')).toBe(true);
    expect(owns('ops_gen_test.go')).toBe(true);
    expect(owns('client.go')).toBe(false);
    expect(owns('go.mod')).toBe(false);
  });
});

describe('Go types', () => {
  const models = new Models({ Status: { type: 'string', enum: ['a', 'b'] } });
  const types = new GoTypes(models);
  const of = (s: object) => types.of(models.lower(s, 'T')).t;
  it('maps the schema subset', () => {
    expect(of({ type: 'integer' })).toBe('int64');
    expect(of({ type: ['string', 'null'] })).toBe('string');
    expect(of({ enum: ['a', 'b'] })).toBe('string');
    expect(of({ type: 'array', items: { type: 'string' } })).toBe('[]string');
    expect(of({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'map[string]float64',
    );
    expect(of({ anyOf: [{ type: 'string' }, { type: 'object' }] })).toBe('any');
    expect(of({ $ref: '#/components/schemas/Status' })).toBe('Status');
  });
  it('points to what can be absent or null, unless Go can already say so', () => {
    expect(types.optional(models.lower({ type: 'string' }, 'T'))).toBe('*string');
    expect(types.optional(models.lower({ type: 'array', items: { type: 'string' } }, 'T'))).toBe(
      '[]string',
    );
  });
  it('spells initialisms the Go way', () => {
    expect(goName('externalId')).toBe('ExternalID');
    expect(goName('publicUrl')).toBe('PublicURL');
    expect(goName('apiKeys')).toBe('APIKeys');
  });
});
