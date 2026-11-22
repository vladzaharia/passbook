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
    for (const [name, value] of Object.entries(ref.requests ?? {}))
      expect(validateAgainst(doc, request ?? {}, value), `${id} request ${name}`).toEqual([]);
    if (ref.response !== undefined) {
      expect(response, `${id} has no JSON 2xx body`).toBeTruthy();
      expect(validateAgainst(doc, response ?? {}, ref.response), `${id} response`).toEqual([]);
    }
  });
});

type Media2 = { schema?: object; example?: unknown };
type KeyOp = {
  operationId: string;
  security?: Record<string, unknown>[];
  requestBody?: { content?: Record<string, Media2> };
  responses?: Record<string, { content?: Record<string, Media2> }>;
};

describe('the document', () => {
  const keyOps = Object.values((doc.paths ?? {}) as Record<string, Record<string, KeyOp>>)
    .flatMap((item) => Object.values(item))
    .filter((op) => op.security?.some((s) => 'apiKey' in s));

  it('has a request and a response example on every key-callable JSON body, each valid and named', () => {
    const bad: string[] = [];
    const check = (id: string, what: string, media: Media2 | undefined) => {
      if (!media) return;
      if (media.example === undefined) bad.push(`${id}: no ${what} example`);
      else if (!media.schema || !('$ref' in media.schema)) bad.push(`${id}: ${what} is not named`);
      else if (validateAgainst(doc, media.schema, media.example).length)
        bad.push(`${id}: ${what} example does not match its schema`);
    };
    for (const op of keyOps) {
      check(op.operationId, 'request', op.requestBody?.content?.['application/json']);
      const ok = Object.entries(op.responses ?? {}).find(([code]) => code.startsWith('2'));
      check(op.operationId, 'response', ok?.[1].content?.['application/json']);
    }
    expect(bad).toEqual([]);
  });
});
