import { env } from 'cloudflare:workers';
import { Hono, type MiddlewareHandler } from 'hono';
import { describe, expect, it } from 'vitest';
import { type FakeAuth, fakeAuth } from '../../../test/helpers/fake-auth.ts';
import {
  type Amr,
  requireAdmin,
  requireCaller,
  requireHolderSession,
  requireSession,
} from './auth.ts';
import { type AppBindings, requestContext } from './context.ts';
import type { AppEnv } from './env.ts';
import { handleError } from './error-handler.ts';

const ORIGIN = 'https://wallet.test';
type Guard = MiddlewareHandler<AppBindings>;

const guards: Record<string, { guard: Guard; admin?: true; any?: true }> = {
  requireSession: { guard: requireSession },
  requireHolderSession: { guard: requireHolderSession, any: true },
  requireAdmin: { guard: requireAdmin, admin: true },
  'scope route': { guard: requireCaller({ scope: 'passes:read' }) },
  'human route': { guard: requireCaller({ human: true }) },
  'human route, signIn any': { guard: requireCaller({ human: true, signIn: 'any' }), any: true },
  'tenant human route': { guard: requireCaller({ human: true, requestMode: true }) },
  'platform route': { guard: requireCaller({ platform: 'platform:users' }), admin: true },
};

const sessions: { name: string; amr: Amr; consoleUntil?: number | null; strong: boolean }[] = [
  { name: 'Polaris ID', amr: 'oidc', strong: true },
  { name: 'break-glass', amr: 'breakglass', strong: true },
  { name: 'email link', amr: 'magic_link', strong: false },
  {
    name: 'email link in grace',
    amr: 'magic_link',
    consoleUntil: Date.now() + 3_600_000,
    strong: true,
  },
  {
    name: 'email link, grace over',
    amr: 'magic_link',
    consoleUntil: Date.now() - 1,
    strong: false,
  },
];

async function call(guard: Guard, fake: FakeAuth, headers: Record<string, string>) {
  const app = new Hono<AppBindings>();
  app.use('*', requestContext({ stores: fake.stores }));
  app.onError(handleError);
  app.get('/api/v1/x', guard, (c) => c.json({ ok: true }));
  const res = await app.request(`${ORIGIN}/api/v1/x`, { headers }, env as AppEnv);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('sign-in strength at the route guard', () => {
  for (const [name, { guard, admin, any }] of Object.entries(guards))
    for (const s of sessions) {
      const roles = admin ? (['admin', 'user'] as const) : (['user'] as const);
      const allowed = any || s.strong;
      it(`${name}: ${s.name} ${allowed ? 'passes' : 'is refused'}`, async () => {
        const fake = fakeAuth(ORIGIN);
        const headers = fake.session({
          roles: [...roles],
          amr: s.amr,
          consoleUntil: s.consoleUntil ?? null,
        });
        const { status, body } = await call(guard, fake, headers);
        if (allowed) expect(status).toBe(200);
        else {
          expect(status).toBe(403);
          expect(body.code).toBe('IDP_SIGN_IN_REQUIRED');
          expect(body.signInUrl).toBe('/auth/oidc/start?next=/admin');
          expect(fake.denied.map((d) => d.code)).toEqual(['IDP_SIGN_IN_REQUIRED']);
        }
      });
    }

  it('answers an anonymous caller 401, whatever the level', async () => {
    for (const { guard } of Object.values(guards))
      expect((await call(guard, fakeAuth(ORIGIN), {})).status).toBe(401);
  });
});
