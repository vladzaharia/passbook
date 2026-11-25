import { describe, expect, it } from 'vitest';
import { copyAs } from './copy-as.ts';
import {
  buildSent,
  initialDraft,
  inputUnchecked,
  problems,
  skeleton,
  swapTemplate,
  target,
  wireOf,
} from './request.ts';
import { passesCreate, passesVoid } from './test-support.ts';

describe('request', () => {
  it("fills `input` from the template's sample wherever it swaps the template", () => {
    const d = initialDraft(passesCreate, 'tpl_sandbox', { eventName: 'Gala' });
    expect(JSON.parse(d.body)).toEqual({ templateId: 'tpl_sandbox', input: { eventName: 'Gala' } });
    // No template named: an `input` is not the sandbox's to replace.
    expect(swapTemplate({ input: { a: 1 } }, 'tpl', { b: 2 })).toEqual({ input: { a: 1 } });
  });
  it("checks `input` against the template's schema, or says it did not", () => {
    const check = {
      templateId: 'tpl_1',
      schema: {
        type: 'object',
        required: ['eventName'],
        properties: { eventName: { type: 'string' } },
      },
    };
    const d = initialDraft(passesCreate);
    expect(inputUnchecked(passesCreate, d)).toBe(true);
    expect(problems(passesCreate, d, check).map((i) => i.path)).toEqual(['input.eventName']);
    expect(inputUnchecked(passesCreate, d, check)).toBe(false);
    expect(inputUnchecked(passesCreate, d, { ...check, templateId: 'other' })).toBe(true);
    expect(problems(passesCreate, d, { ...check, templateId: 'other' })).toEqual([]);
    expect(inputUnchecked(passesVoid, initialDraft(passesVoid), check)).toBe(false);
  });
  it('starts from the document example with the sandbox template swapped in', () => {
    const d = initialDraft(passesCreate, 'tpl_sandbox');
    expect(JSON.parse(d.body)).toEqual({ templateId: 'tpl_sandbox', input: { name: 'Ada' } });
    expect(d.idemOn).toBe(true);
    expect(d.idemKey).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('builds a skeleton of the required fields when there is no example', () => {
    expect(
      skeleton({
        type: 'object',
        required: ['a', 'b'],
        properties: { a: { type: 'string' }, b: { enum: ['x'] }, c: { type: 'integer' } },
      }),
    ).toEqual({ a: '', b: 'x' });
    expect(swapTemplate({ a: [{ templateId: 'old' }] }, null)).toEqual({
      a: [{ templateId: 'old' }],
    });
  });
  it('fills path parameters (encoded) and the query string', () => {
    const d = initialDraft(passesVoid);
    d.path.id = 'a/b';
    expect(target(passesVoid, d)).toBe('/api/v1/passes/a%2Fb/void');
    expect(problems(passesVoid, initialDraft(passesVoid)).map((i) => i.path)).toEqual(['id']);
    const q = {
      ...passesVoid,
      params: [
        {
          name: 'limit',
          where: 'query' as const,
          required: false,
          schema: { type: 'integer' },
          description: '',
        },
      ],
    };
    const dq = initialDraft(q);
    dq.query.limit = '5';
    expect(target(q, dq)).toBe('/api/v1/passes/<id>/void?limit=5');
  });
  it('reports bad JSON and schema problems before sending', () => {
    const d = initialDraft(passesCreate);
    d.body = '{';
    expect(problems(passesCreate, d)[0]?.path).toBe('body');
    d.body = '{"input":{}}';
    expect(problems(passesCreate, d).map((i) => i.path)).toEqual(['templateId']);
  });
  it('sends the key header only while it is on, and puts the body and content type on the wire', () => {
    const d = initialDraft(passesCreate);
    const wire = wireOf(passesCreate, d);
    expect(wire.headers['Idempotency-Key']).toBe(d.idemKey);
    expect(wire.headers['content-type']).toBe('application/json');
    expect(wire.path).toBe('/api/v1/passes');
    expect(JSON.parse(wire.body ?? '')).toEqual({ templateId: 'tpl_1', input: { name: 'Ada' } });
    expect(
      wireOf(passesCreate, { ...d, idemOn: false }).headers['Idempotency-Key'],
    ).toBeUndefined();
  });
  it('writes the sent request in four languages, key as a placeholder', () => {
    const sent = buildSent(passesCreate, initialDraft(passesCreate), 'https://passbook.mobile');
    const out = (['curl', 'ts', 'py', 'go'] as const).map((l) => copyAs(l, sent));
    for (const code of out) {
      expect(code).toContain('https://passbook.mobile/api/v1/passes');
      expect(code).toContain('Idempotency-Key');
      expect(code).toMatch(/PASSBOOK_KEY/);
      expect(code).not.toMatch(/pbtry|pbp_/);
    }
    expect(out[0]).toContain("-d '{");
    expect(out[1]).toContain("method: 'POST'");
    expect(out[2]).toContain('httpx.request("POST"');
    expect(out[3]).toContain('http.NewRequest("POST"');
  });
});
