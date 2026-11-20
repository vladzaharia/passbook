import { describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../test/helpers/index.ts';
import { validateAgainst } from '../../../test/helpers/openapi-validate.ts';
import { createApp } from '../app.ts';
import { buildOpenApiDocument } from './openapi-document.ts';
import { REFERENCE } from './openapi-reference.ts';

type Media = { schema?: object };
type Op = {
  operationId: string;
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, { content?: Record<string, Media> }>;
};
const doc = buildOpenApiDocument(createApp({ stores: fakeAuth().stores }));
const byId = new Map(
  Object.values((doc.paths ?? {}) as Record<string, Record<string, Op>>)
    .flatMap((item) => Object.values(item))
    .map((op) => [op.operationId, op]),
);
const entries = Object.entries(REFERENCE);

describe('docs/api/reference', () => {
  it('has an operation for every key', () => {
    expect(entries.filter(([id]) => !byId.has(id)).map(([id]) => id)).toEqual([]);
  });

  it.each(entries)('%s: examples match the schema', (id, ref) => {
    const op = byId.get(id);
    const request = op?.requestBody?.content?.['application/json']?.schema;
    const ok = Object.entries(op?.responses ?? {}).find(([code]) => code.startsWith('2'));
    const response = ok?.[1].content?.['application/json']?.schema;
    if (ref.request !== undefined) {
      expect(request, `${id} has no JSON request body`).toBeTruthy();
      expect(validateAgainst(doc, request ?? {}, ref.request), `${id} request`).toEqual([]);
    }
    if (ref.response !== undefined) {
      expect(response, `${id} has no JSON 2xx body`).toBeTruthy();
      expect(validateAgainst(doc, response ?? {}, ref.response), `${id} response`).toEqual([]);
    }
  });
});
