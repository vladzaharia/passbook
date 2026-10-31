import { type APIRequestContext, expect, request } from '@playwright/test';
import { type Role, stateFile } from './auth.ts';

const BASE = 'http://localhost:5173';

export interface Api {
  ctx: APIRequestContext;
  get<T = any>(path: string): Promise<T>;
  send<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
  dispose(): Promise<void>;
}

/** Real API client acting as a signed-in role (same cookie + CSRF rules as the browser). */
export async function apiAs(role: Role): Promise<Api> {
  const ctx = await request.newContext({ baseURL: BASE, storageState: stateFile(role) });
  const session = await (await ctx.get('/api/v1/session')).json();
  const csrf = session.csrfToken as string;
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await ctx.fetch(path, {
      method,
      headers: { Origin: BASE, 'X-CSRF-Token': csrf, ...headers },
      ...(body === undefined ? {} : { data: body }),
    });
    const text = await res.text();
    if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${text.slice(0, 400)}`);
    return (text ? JSON.parse(text) : undefined) as never;
  };
  return {
    ctx,
    get: (path) => send('GET', path),
    send,
    dispose: () => ctx.dispose(),
  };
}

export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function firstOrg(api: Api): Promise<{ id: string; slug: string; name: string }> {
  const orgs = await api.get('/api/v1/orgs');
  const list = orgs.items ?? orgs;
  expect(list.length).toBeGreaterThan(0);
  return list[0];
}

export const GENERIC = 'baked:starter-generic';

/** Creates a pass through the real API (starter-generic by default). */
export async function createPass(
  api: Api,
  orgId: string,
  options: { holder?: string; memberId?: string; email?: string; templateId?: string; input?: Record<string, unknown> } = {},
) {
  const memberId = options.memberId ?? uid('ID').toUpperCase();
  return api.send(
    'POST',
    '/api/v1/passes',
    {
      orgId,
      templateId: options.templateId ?? GENERIC,
      input: { holder: options.holder ?? `Holder ${memberId}`, memberId, ...(options.input ?? {}) },
      ...(options.email ? { holderEmail: options.email } : {}),
    },
    { 'Idempotency-Key': uid('idem') },
  );
}
