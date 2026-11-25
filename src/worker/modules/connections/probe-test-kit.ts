import { makeSession } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { setDeps } from './deps.ts';
import { addMembership, makeKit } from './test-kit.ts';

export const BASE = 'https://api.example.com/v1';
export const JSON_HEADERS = { 'content-type': 'application/json' };

/** A fake upstream: the handler sees each URL and request headers and returns a Response (or a body). */
export function upstream(
  handler: (url: URL, headers: Headers) => Response | Record<string, unknown> | unknown[],
) {
  const calls: { url: string; headers: Headers }[] = [];
  setDeps({
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({ url: url.toString(), headers });
      const out = handler(url, headers);
      return out instanceof Response
        ? out
        : new Response(JSON.stringify(out), { headers: JSON_HEADERS });
    },
  });
  return calls;
}

export const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });

/** A kit, an org admin session and an app wired to real session and API key stores. */
export async function probeApp() {
  const kit = await makeKit();
  const session = await makeSession(kit, { userId: kit.actor.id, roles: ['admin', 'user'] });
  await addMembership(kit, kit.actor.id, ['org_admin']);
  const app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      apiKeys: createApiKeyStore(kit.env, kit.clock),
    },
    clock: kit.clock,
  });
  async function call(
    path: string,
    body: unknown,
    headers: Record<string, string> = session.headers,
  ) {
    const res = await app.request(
      path,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      kit.env,
    );
    return {
      status: res.status,
      json: (await res.json()) as Record<string, any>,
      headers: res.headers,
    };
  }
  const probe = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    call('/api/v1/connections/probe', {
      orgId: kit.org.id,
      connectorType: 'http-json',
      config: { baseUrl: BASE, ...config },
      target: 'list',
      ...extra,
    });
  return { kit, session, app, call, probe };
}
