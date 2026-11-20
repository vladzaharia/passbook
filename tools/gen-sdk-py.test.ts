import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drift, generate, manifest, OUT, owns } from './gen-sdk-py.ts';
import { Models } from './lib/sdk-model.ts';
import { pyType, resourcesFile, resourceTree, type PyOp } from './lib/sdk-py-emit.ts';
import type { OpenApiDoc, SdkNames } from './lib/sdk-ts-ops.ts';

const root = resolve(import.meta.dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const doc = read<OpenApiDoc>('docs/api/openapi.v1.json');
const names = read<SdkNames>('docs/api/sdk-names.json');

describe('the committed Python SDK', () => {
  it('matches the generator (run `node tools/gen-sdk-py.ts` after changing the API)', () => {
    const files = generate(doc, names);
    files.set('../../../tests/ops.json', manifest(doc, names));
    expect(drift(files, resolve(root, OUT), owns)).toEqual([]);
  });

  it('names methods in snake_case from x-sdk, and keeps delete', () => {
    const resources = generate(doc, names).get('resources.py') ?? '';
    expect(resources).toContain('self.webhook_endpoints = WebhookEndpointsResource(core)');
    expect(resources).toContain('def retrieve_input_schema(');
    expect(resources).toMatch(/def delete\(\s+self,\s+id: str,/);
  });

  it('sends an Idempotency-Key only where the document declares it', () => {
    const rows = JSON.parse(manifest(doc, names)) as Array<{ call: string; idempotent: boolean }>;
    expect(rows.filter((r) => r.idempotent).map((r) => r.call)).toContain('passes.create');
  });
});

describe('pyType', () => {
  const models = new Models({});
  const ty = (s: object) => pyType(models.lower(s, 'T'));
  it('maps the schema subset', () => {
    expect(ty({ type: ['string', 'null'] })).toBe('str | None');
    expect(ty({ type: 'integer' })).toBe('int');
    expect(ty({ enum: ['a', 'b'] })).toBe('_Literal["a", "b"]');
    expect(ty({ type: 'array', items: { type: 'string' } })).toBe('_List[str]');
    expect(ty({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      '_Dict[str, float]',
    );
    expect(ty({})).toBe('_Any');
  });
  it('opens string enums on the response side only when asked', () => {
    const open = (s: object) => pyType(models.lower(s, 'T'), '', true);
    expect(open({ enum: ['a', 'b'] })).toBe('_Literal["a", "b"] | str');
    expect(open({ type: 'array', items: { enum: ['a'] } })).toBe('_List[_Literal["a"] | str]');
  });
  it('rejects an unknown type rather than guessing', () => {
    expect(() => ty({ type: 'bytes' })).toThrow(/Unsupported/);
  });
});

describe('the Python resources', () => {
  it('refuses a method and a child resource with the same name', () => {
    const op = (resource: string[], method: string) =>
      ({
        op: { resource, method, http: 'GET', path: '/x', schemas: { path: [], query: [] } },
        path: [],
        query: [],
      }) as unknown as PyOp;
    const tree = resourceTree([op(['passes'], 'events'), op(['passes', 'events'], 'list')]);
    expect(() => resourcesFile(tree)).toThrow(/same name|name of a method/);
  });
});
