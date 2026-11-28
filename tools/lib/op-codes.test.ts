import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { routeKey } from './op-codes.ts';
import type { Doc } from './openapi-diff.ts';

const read = <T>(file: string): T =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../..', file), 'utf8')) as T;
const table = read<Record<string, string[]>>('docs/api/operation-codes.json');

describe('operation codes', () => {
  it("drops the codes under an @absorbs function and keeps the route's own", () => {
    const make = table[routeKey('developer', 'post', '/')] ?? [];
    expect(make).toContain('DEVICE_PASS_LIMIT');
    expect(make).not.toContain('IDENTITY_RETIRED');
  });

  it('lists what a handler reaches, not what its module throws', () => {
    const codes = table[routeKey('templates', 'get', '/{id}/input-schema')] ?? [];
    expect(codes).toContain('TEMPLATE_NOT_FOUND');
    expect(codes).not.toContain('ARCHIVE_TOO_LARGE');
    expect(codes).not.toContain('ASSETS_INVALID');
  });

  it('follows a function passed through a loop to the code it throws', () => {
    const void_ = table[routeKey('passes', 'post', '/{id}/void')] ?? [];
    expect(void_).toContain('PASS_NOT_FOUND');
  });

  it('puts the shared auth and validation codes on the operation, beside its own', () => {
    const doc = read<Doc>('docs/api/openapi.v1.json');
    const op = doc.paths?.['/api/v1/templates/{id}/input-schema']?.get as { 'x-codes': string[] };
    for (const c of [
      'UNAUTHENTICATED',
      'MISSING_SCOPE',
      'VALIDATION',
      'NOT_FOUND',
      'TEMPLATE_NOT_FOUND',
    ])
      expect(op['x-codes']).toContain(c);
    expect(op['x-codes']).not.toContain('ARCHIVE_TOO_LARGE');
  });
});
