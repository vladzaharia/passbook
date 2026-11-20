import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import type { AppBindings } from '../../platform/context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  codeOf,
  grantScanMembership,
  key,
  ORIGIN,
  type ScanKit,
  setupScanKit,
} from './test-kit.ts';

const CHECK_IN = { id: 'check_in', label: 'Check in', kind: 'check_in' } as const;
let kit: ScanKit;
let app: OpenAPIHono<AppBindings>;
let headers: Record<string, string>;
let day: string;
let guest: string;

beforeAll(async () => {
  kit = await setupScanKit();
  kit.clock.set(Date.UTC(2026, 0, 1, 12));
  app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(kit.env, kit.clock) },
    clock: kit.clock,
  });
  const user = await makeUser(kit.fx);
  await grantScanMembership(kit.fx, kit.org.id, user.id, ['org_admin']);
  headers = (await makeSession(kit.fx, { userId: user.id, roles: ['admin', 'user'] })).headers;
  day = await kit.scanTemplate('Day pass', { actions: [CHECK_IN] });
  guest = await kit.scanTemplate('Guest pass', { actions: [CHECK_IN] });
  // Three scans on the day type, one on the guest type, one refused.
  for (const t of [day, day, day, guest]) await scan(await kit.scanPass(t), [day, guest]);
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(
    `${ORIGIN}${path}`,
    { ...init, headers: { ...headers, origin: ORIGIN, 'content-type': 'application/json' } },
    kit.env,
  );

async function scan(pass: Awaited<ReturnType<ScanKit['scanPass']>>, templateIds: string[]) {
  const res = await call('/api/v1/scan/actions', {
    method: 'POST',
    body: JSON.stringify({
      input: codeOf(pass),
      idempotencyKey: key(),
      clientTs: kit.clock.now(),
      actionId: 'check_in',
      scope: { orgId: kit.org.id, templateIds, timeZone: 'UTC' },
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    kind: string;
    counts: {
      today: number;
      byType?: { templateId: string | null; name: string | null; count: number }[];
    };
  };
}

describe('counts by pass type', () => {
  it('splits today by type and the rows sum to the total', async () => {
    const out = await scan(await kit.scanPass(day), [day, guest]);
    const rows = out.counts.byType ?? [];
    expect(rows.map((r) => [r.name, r.count])).toEqual([
      ['Day pass', 4],
      ['Guest pass', 1],
    ]);
    expect(rows.reduce((n, r) => n + r.count, 0)).toBe(out.counts.today);
  });

  it('leaves the split out where one pass type is admitted', async () => {
    const out = await scan(await kit.scanPass(guest), [guest]);
    expect(out.counts.byType).toBeUndefined();
  });
});

describe('feed filter by pass type', () => {
  const list = async (query: string) => {
    const res = await call(`/api/v1/scans?orgId=${kit.org.id}&${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { templateId: string | null }[] };
  };

  it('lists only the scans of the type', async () => {
    const days = await list(`templateId=${day}`);
    expect(days.items.length).toBeGreaterThan(0);
    expect(days.items.every((i) => i.templateId === day)).toBe(true);
    const guests = await list(`templateId=${guest}`);
    expect(guests.items.every((i) => i.templateId === guest)).toBe(true);
    expect((await list('')).items.length).toBe(days.items.length + guests.items.length);
  });

  it("matches nothing for another organization's type", async () => {
    const other = await makeOrg(kit.fx);
    const foreign = await kit.scanTemplate(
      'Foreign type',
      { actions: [CHECK_IN] },
      { orgId: other.id },
    );
    expect((await list(`templateId=${foreign}`)).items).toEqual([]);
  });
});
