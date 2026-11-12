import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeScanner,
  makeTemplate,
  makeUser,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(env.DB, clock);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  await grantScanMembership(f, orgId, userId);
});

async function template(): Promise<string> {
  const t = makeTemplate({ id: f.ids.id(), orgId });
  await persistTemplate(f, t.resolved, { registry: t.registry });
  await approveAppleRelease(
    { ctx: createServiceContext(env, { clock }), fx: f, registry: t.registry },
    { orgId, templateId: t.resolved.id, version: t.resolved.version, mode: 'live' },
  );
  return t.resolved.id;
}

const archive = (id: string) =>
  run(env.DB, "UPDATE templates SET status='archived' WHERE id=?", [id]);

const call = (method: string, path: string, body?: unknown) =>
  app.request(
    `${ORIGIN}/api/v1/scan-events${path}`,
    {
      method,
      headers: {
        ...fake.session({ userId, roles: ['admin', 'user'] }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );

async function event(templateIds: string[]) {
  clock.advance(1);
  const res = await call('POST', '', {
    orgId,
    name: `Event ${f.ids.token(3)}`,
    templateIds,
    opensAt: clock.now() - HOUR,
    closesAt: clock.now() + HOUR,
    timeZone: 'Europe/Berlin',
  });
  return { res, body: (await res.clone().json()) as { id: string; code?: string } };
}

describe('archived templates on an event', () => {
  it('keeps scanner assignment and match edits working for a template archived after it was attached', async () => {
    const kept = await template();
    const { res, body } = await event([kept]);
    expect(res.status).toBe(201);
    await archive(kept);
    const scanner = await makeScanner(f, { orgId });
    const assigned = await call('POST', `/${body.id}/scanners`, { scannerIds: [scanner.id] });
    expect(assigned.status).toBe(200);
    expect(await assigned.json()).toMatchObject({ scanners: 1 });
    const matched = await call('PATCH', `/${body.id}`, {
      match: { input: 'memberName', values: ['Alex Morgan'] },
    });
    expect(matched.status).toBe(200);
    expect(await matched.json()).toMatchObject({
      match: { input: 'memberName', values: ['Alex Morgan'] },
    });
  });

  it('refuses a newly attached archived template with 422 TEMPLATE_ARCHIVED, and takes an active one', async () => {
    const kept = await template();
    const archived = await template();
    await archive(archived);
    const refusedCreate = await event([archived]);
    expect(refusedCreate.res.status).toBe(422);
    expect(refusedCreate.body.code).toBe('TEMPLATE_ARCHIVED');
    const { body } = await event([kept]);
    const refusedAdd = await call('PATCH', `/${body.id}`, { templateIds: [kept, archived] });
    expect(refusedAdd.status).toBe(422);
    expect(await refusedAdd.json()).toMatchObject({ code: 'TEMPLATE_ARCHIVED' });
    const active = await template();
    const added = await call('PATCH', `/${body.id}`, { templateIds: [kept, active] });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      templateIds: expect.arrayContaining([kept, active]),
    });
  });
});
