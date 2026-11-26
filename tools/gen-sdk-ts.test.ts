import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { drift, errorCodes, generate, OUT } from './gen-sdk-ts.ts';
import { type OpenApiDoc, type SdkNames, sdkOperations } from './lib/sdk-ts-ops.ts';
import { tsType } from './lib/sdk-ts-schema.ts';

const root = resolve(import.meta.dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(resolve(root, file), 'utf8')) as T;
const doc = read<OpenApiDoc>('docs/api/openapi.v1.json');
const names = read<SdkNames>('docs/api/sdk-names.json');

describe('the committed TypeScript SDK', () => {
  it('matches the generator (run `node tools/gen-sdk-ts.ts` after changing the API)', () => {
    expect(
      drift(generate(doc, names, errorCodes(read('docs/api/errors.json'))), resolve(root, OUT)),
    ).toEqual([]);
  });

  it('exposes exactly the key-reachable operations that are not sdk: false', () => {
    const ops = sdkOperations(doc, names);
    const keyed = Object.values(doc.paths)
      .flatMap(
        (item) => Object.values(item) as Array<{ operationId?: string; security?: object[] }>,
      )
      .filter((op) => op.operationId && op.security?.some((s) => 'apiKey' in s))
      .filter((op) => names[op.operationId as string]?.sdk !== false);
    expect(ops.map((o) => o.id).sort()).toEqual(keyed.map((o) => o.operationId).sort());
    for (const op of ops) {
      expect([op.resource.join('.'), op.method]).toEqual([
        names[op.id]?.resource,
        names[op.id]?.method,
      ]);
    }
  });

  it('adds an Idempotency-Key only where the document declares it', () => {
    const ids = sdkOperations(doc, names)
      .filter((o) => o.idempotent)
      .map((o) => `${o.resource.join('.')}.${o.method}`);
    expect(ids).toContain('passes.create');
    expect(ids).toContain('operations.retry');
    // A bound, not a count: only operations that declare the header get one (operations retry joined the 11).
    expect(ids.length).toBeLessThan(16);
  });

  it('returns the Response of a download, and nothing for a call with no body', () => {
    const ops = sdkOperations(doc, names);
    const downloads = ops.filter((o) => o.http === 'GET' && o.result === 'Response');
    expect(downloads.map((o) => `${o.resource.join('.')}.${o.method}`)).toContain(
      'passImports.downloadResults',
    );
    expect(downloads.every((o) => o.raw)).toBe(true);
    expect(ops.filter((o) => o.http === 'GET' && o.result === 'void')).toEqual([]);
  });

  it('paginates lists that return items and nextCursor, by cursor or after', () => {
    const paged = Object.fromEntries(
      sdkOperations(doc, names)
        .filter((o) => o.cursor)
        .map((o) => [`${o.resource.join('.')}.${o.method}`, o.cursor]),
    );
    expect(paged).toMatchObject({ 'passes.list': 'cursor', 'events.list': 'after' });
  });
});

describe('tsType', () => {
  it('maps the schema subset', () => {
    expect(tsType({ type: ['string', 'null'] })).toBe('string | null');
    expect(tsType({ type: 'integer' })).toBe('number');
    expect(tsType({ enum: ['a', 'b'] })).toBe('"a" | "b"');
    expect(tsType({ $ref: '#/components/schemas/Pass' })).toBe('Pass');
    expect(tsType({ type: 'array', items: { type: 'string' } })).toBe('Array<string>');
    expect(tsType({ type: 'object', additionalProperties: { type: 'number' } })).toBe(
      'Record<string, number>',
    );
    expect(tsType({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }] })).toBe(
      '[string, number]',
    );
    expect(tsType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(tsType({})).toBe('unknown');
  });

  it('marks optional properties, quotes odd keys, and opens objects that allow extras', () => {
    const text = tsType({
      type: 'object',
      properties: { id: { type: 'string' }, 'a-b': { type: 'boolean' } },
      required: ['id'],
      additionalProperties: {},
    });
    expect(text).toBe('{\n  id: string;\n  "a-b"?: boolean;\n  [key: string]: unknown;\n}');
  });

  it('rejects an unknown type rather than guessing', () => {
    expect(() => tsType({ type: 'bytes' })).toThrow(/Unsupported/);
  });
});
