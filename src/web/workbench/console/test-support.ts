import { vi } from 'vitest';
import type { RunOp } from './types.ts';

export const TOKEN = 'pbtry_SECRETPAYLOAD123.SIGNATUREabc';

export interface Call {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export const passesCreate: RunOp = {
  id: 'passes.postPasses',
  anchor: 'create',
  title: 'Create a pass',
  method: 'post',
  path: '/api/v1/passes',
  idempotent: true,
  destructive: false,
  params: [],
  body: {
    type: 'object',
    required: ['templateId', 'input'],
    properties: {
      templateId: { type: 'string', minLength: 1 },
      input: { type: 'object' },
      holderEmail: { type: 'string', maxLength: 254 },
    },
  },
  example: { templateId: 'tpl_1', input: { name: 'Ada' } },
};

export const passesVoid: RunOp = {
  ...passesCreate,
  id: 'passes.postPassesByIdVoid',
  anchor: 'void',
  title: 'Void a pass',
  path: '/api/v1/passes/{id}/void',
  idempotent: false,
  destructive: true,
  params: [
    {
      name: 'id',
      where: 'path',
      required: true,
      schema: { type: 'string', minLength: 1 },
      description: '',
    },
  ],
  body: null,
  example: undefined,
};

type Reply = (call: Call) => Response | Promise<Response>;

/** Stands in for the network: records every call and answers the mint itself. */
export function fakeNetwork(reply: Reply): { calls: Call[]; mints: () => number } {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const call: Call = {
        path: String(input),
        method: init.method ?? 'GET',
        headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
        body: typeof init.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      if (call.path === '/api/v1/developer/try-token')
        return Response.json({ token: TOKEN, expiresAt: Date.now() + 900_000 }, { status: 201 });
      return reply(call);
    }),
  );
  return {
    calls,
    mints: () => calls.filter((c) => c.path === '/api/v1/developer/try-token').length,
  };
}

export const json = (body: unknown, init: ResponseInit = {}) =>
  Response.json(body, { status: 200, ...init });
