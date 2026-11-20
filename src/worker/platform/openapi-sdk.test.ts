import { describe, expect, it } from 'vitest';
import names from '../../../docs/api/sdk-names.json';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { createApp } from '../app.ts';
import { buildOpenApiDocument } from './openapi-document.ts';

type Op = {
  operationId: string;
  security?: object[];
  tags?: string[];
  'x-sdk'?: { resource: string; method: string; sdk?: boolean; reason?: string };
};
const doc = buildOpenApiDocument(createApp({ stores: fakeAuth().stores }));
const ops = Object.values((doc.paths ?? {}) as Record<string, Record<string, Op>>).flatMap((item) =>
  Object.values(item),
);
const table = names as Record<string, { sdk?: boolean; reason?: string }>;

describe('x-sdk', () => {
  it('names exactly the operations of the document', () => {
    expect(ops.map((o) => o.operationId).sort()).toEqual(Object.keys(table).sort());
  });

  it('puts x-sdk on every operation, with unique resource.method pairs', () => {
    expect(ops.filter((o) => !o['x-sdk']).map((o) => o.operationId)).toEqual([]);
    const pairs = ops.map((o) => `${o['x-sdk']?.resource}.${o['x-sdk']?.method}`);
    expect(pairs.filter((p, i) => pairs.indexOf(p) !== i)).toEqual([]);
  });

  it('gives every sdk:false entry a reason and no key access', () => {
    const hidden = ops.filter((o) => o['x-sdk']?.sdk === false);
    expect(hidden.length).toBeGreaterThan(0);
    for (const op of hidden) {
      expect(op['x-sdk']?.reason, op.operationId).toBeTruthy();
      expect(JSON.stringify(op.security ?? []), op.operationId).not.toContain('apiKey');
    }
  });

  it('uses kebab-case tags', () => {
    const bad = ops.flatMap((o) => o.tags ?? []).filter((t) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t));
    expect(bad).toEqual([]);
  });
});
