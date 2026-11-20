import { describe, expect, it } from 'vitest';
import { breakingChanges, type Doc } from './lib/openapi-diff.ts';

describe('breakingChanges', () => {
  const base = (): Doc => ({
    paths: {
      '/a': {
        post: {
          operationId: 'x.postA',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { n: { type: 'string' } }, required: ['n'] },
              },
            },
          },
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { id: { type: 'string' }, kind: { enum: ['a', 'b'] } },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  const edit = (f: (d: Doc) => void): string[] => {
    const next = base();
    f(next);
    return breakingChanges(base(), next);
  };
  const op = (d: Doc) =>
    d.paths?.['/a']?.post as {
      requestBody: { content: Record<string, { schema: Record<string, unknown> }> };
      responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }>;
    };

  it('passes an identical or additive document', () => {
    expect(edit(() => {})).toEqual([]);
    expect(
      edit((d) => {
        (
          op(d).responses['200']?.content['application/json']?.schema.properties as object &
            Record<string, unknown>
        ).extra = {
          type: 'string',
        };
      }),
    ).toEqual([]);
  });

  it('fails a removed operation', () => {
    expect(edit((d) => void delete d.paths?.['/a'])).toEqual(['POST /a: operation removed']);
  });

  it('fails a removed response field and enum value', () => {
    const found = edit((d) => {
      const s = op(d).responses['200']?.content['application/json']?.schema as Record<
        string,
        Record<string, unknown>
      >;
      delete s.properties?.id;
      s.properties = { ...s.properties, kind: { enum: ['a'] } };
    });
    expect(found.join('\n')).toMatch(/\.id: field removed/);
    expect(found.join('\n')).toMatch(/enum value "b" removed/);
  });

  it('fails a tightened request', () => {
    const found = edit((d) => {
      const s = op(d).requestBody.content['application/json']?.schema as Record<string, unknown>;
      s.properties = { ...(s.properties as object), m: { type: 'string' } };
      s.required = ['n', 'm'];
    });
    expect(found).toEqual(['POST /a body.m: now required']);
  });

  it('fails a changed operationId', () => {
    const found = edit((d) => {
      const o = d.paths?.['/a']?.post as { operationId: string };
      o.operationId = 'y';
    });
    expect(found[0]).toMatch(/operationId/);
  });
});
