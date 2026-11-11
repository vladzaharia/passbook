/* istanbul ignore file -- @preserve */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { expect } from 'vitest';
import { makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { ScanSessionSchema } from '../../../shared/contracts/scan-session.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { type TenantPassWrite, tenantAuthorityOf } from '../passes/http.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, key, type ScanKit, setupScanKit } from './test-kit.ts';

export const ORIGIN = 'https://wallet.test';
export const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
export let kit: ScanKit;
export let admin: Record<string, string>;
export let adminUserId: string;
export let adminAuthority: TenantPassWrite;
let app: OpenAPIHono<AppBindings>;
export async function setupScanningAuthorityFixture() {
  kit = await setupScanKit();
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id);
  const platformSession = await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] });
  admin = platformSession.headers;
  adminUserId = user.id;
  const resolved = await createSessionStore(kit.env, kit.clock).resolve(
    platformSession.cookieValue,
  );
  if (!resolved) throw new Error('Missing D1 admin session.');
  adminAuthority = await tenantAuthorityOf(kit.ctx, resolved, kit.org.id, 'scanning:manage');
  app = createApp({
    clock: kit.clock,
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(kit.env, kit.clock),
      scanners: createScannerStore(kit.env, kit.clock),
    },
  });
}

export function request(method: string, path: string, body?: unknown, headers = admin) {
  return app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
}

export async function created(path: string, body: unknown) {
  const response = await request('POST', path, body);
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; pairing?: { code: string } | null };
}

export async function pair(code: string) {
  const response = await request('POST', '/scan/pair', { code }, {});
  expect(response.status).toBe(200);
  const session = ScanSessionSchema.parse(await response.json());
  return {
    cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '',
    'x-csrf-token': session.csrfToken ?? '',
    'sec-fetch-site': 'same-origin',
  };
}

export async function sessionWithDevice(
  accepts: { eventId: string } | { templateIds: string[] },
  surface: 'phone' | 'auto' = 'phone',
) {
  const session = await created('/scanning-sessions', {
    orgId: kit.org.id,
    name: `Session ${kit.fx.ids.token(5)}`,
    timeZone: 'UTC',
    accepts,
  });
  const device = await created(`/scanning-sessions/${session.id}/devices`, {
    name: `Device ${kit.fx.ids.token(5)}`,
    surface,
  });
  if (!device.pairing) throw new Error('Expected a device pairing code.');
  return { session, device, headers: await pair(device.pairing.code) };
}

export async function expectUnassigned(headers: Record<string, string>, passCode: unknown) {
  const response = await request('GET', '/scan/session', undefined, headers);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    state: 'unassigned',
    scanner: { settings: { acceptAllTemplates: false } },
    workspace: null,
  });
  const resolution = await request(
    'POST',
    '/scan/resolve',
    {
      idempotencyKey: key(),
      input: passCode,
      clientTs: kit.clock.now(),
    },
    headers,
  );
  expect(resolution.status).toBe(200);
  expect(await resolution.json()).toMatchObject({ kind: 'refused', reason: 'not_accepted' });
}
