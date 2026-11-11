import { beforeEach, describe, expect, it } from 'vitest';
import {
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeTemplate,
  makeUser,
  persistTemplate,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { approveAppleRelease } from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { createScannerStore } from './auth-store.ts';
import { grantScanMembership, makeLegacyScanPass } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const HOUR = 3_600_000;

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

let env: AppEnv;
let f: Fixtures;
let clock: ManualClock;
let fake: ReturnType<typeof fakeAuth>;
let app: ReturnType<typeof createApp>;
let orgId: string;
let userId: string;
let templateId: string;

beforeEach(async () => {
  clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  env = await makeEnv();
  await ensureCredentialRefKeyset(env.DB, env);
  f = fixtures(env, clock);
  fake = fakeAuth(ORIGIN);
  fake.bindSessions(env.DB, clock);
  app = createApp({ stores: { ...fake.stores, scanners: createScannerStore(env, clock) }, clock });
  await run(env.DB, 'DELETE FROM audit_log');
  userId = (await makeUser(f)).id;
  orgId = (await makeOrg(f)).id;
  await grantScanMembership(f, orgId, userId);
  templateId = await template(orgId);
});

async function persistApprovedTemplate(t: TestTemplate, org: string): Promise<void> {
  await persistTemplate(f, t.resolved, { registry: t.registry });
  const fixture = { ctx: createServiceContext(env, { clock }), fx: f, registry: t.registry };
  for (const mode of ['live', 'test'] as const) {
    await approveAppleRelease(fixture, {
      orgId: org,
      templateId: t.resolved.id,
      version: t.resolved.version,
      mode,
    });
  }
}

async function template(org: string, manifest: Record<string, unknown> = {}): Promise<string> {
  const t = makeTemplate({ id: f.ids.id(), orgId: org });
  Object.assign(t.resolved.manifest, manifest);
  await persistApprovedTemplate(t, org);
  return t.resolved.id;
}
const admin = (mode?: 'test') =>
  fake.session({ userId, roles: ['admin', 'user'], ...(mode ? { mode } : {}) });
const call = (method: string, path: string, body?: unknown, headers = admin()) =>
  app.request(
    `${ORIGIN}/api/v1/scan-events${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? null : JSON.stringify(body),
    },
    env,
  );
interface Ev {
  id: string;
  status: string;
  arrived: number;
  expected: number;
  scanners: number;
  note: string | null;
  templateIds: string[];
  match: { input: string; values: string[] } | null;
  code?: string;
}
async function create(over: Record<string, unknown> = {}, headers = admin()) {
  clock.advance(1);
  const res = await call(
    'POST',
    '',
    {
      orgId,
      name: `Event ${f.ids.token(3)}`,
      templateIds: [templateId],
      opensAt: clock.now() - HOUR,
      closesAt: clock.now() + HOUR,
      timeZone: 'Europe/Berlin',
      ...over,
    },
    headers,
  );
  return { res, body: (await res.clone().json()) as Ev };
}
const auditActions = async () => {
  const rows = await all<{ action: string }>(
    env.DB,
    "SELECT action FROM audit_log WHERE action LIKE 'scan_event.%' ORDER BY id",
  );
  return rows.map((r) => r.action);
};

describe('events', () => {
  it('creates, reads and edits an event with a status', async () => {
    const { res, body } = await create({
      name: 'Gala',
      capacity: 200,
      reentry: true,
      note: 'Doors at 7.',
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({
      status: 'live',
      templateIds: [templateId],
      arrived: 0,
      expected: 0,
      scanners: 0,
      note: 'Doors at 7.',
    });
    const got = (await (await call('GET', `/${body.id}`)).json()) as Ev;
    expect(got.id).toBe(body.id);
    const edited = await call('PATCH', `/${body.id}`, {
      name: 'Gala 2',
      opensAt: clock.now() + HOUR,
      closesAt: clock.now() + 2 * HOUR,
    });
    expect(((await edited.json()) as Ev).status).toBe('upcoming');
    clock.advance(5 * HOUR);
    expect(((await (await call('GET', `/${body.id}`)).json()) as Ev).status).toBe('ended');
    expect(await auditActions()).toEqual(['scan_event.create', 'scan_event.update']);
  });

  it('lists by mode and org, filters by status and pages', async () => {
    const other = await makeOrg(f);
    await grantScanMembership(f, other.id, userId);
    const a = await create({
      name: 'A',
      opensAt: clock.now() - 3 * HOUR,
      closesAt: clock.now() - 2 * HOUR,
    });
    const b = await create({ name: 'B' });
    await create({ name: 'T' }, admin('test'));
    await create({ orgId: other.id, name: 'Other', templateIds: [await template(other.id)] });
    const page = async (q: string, headers = admin()) =>
      (await (await call('GET', q, undefined, headers)).json()) as {
        items: Ev[];
        nextCursor: string | null;
      };
    expect((await page(`?orgId=${orgId}`)).items.map((e) => e.id)).toEqual([b.body.id, a.body.id]);
    expect((await page(`?orgId=${orgId}`, admin('test'))).items).toHaveLength(1);
    expect((await page(`?orgId=${orgId}&status=ended`)).items.map((e) => e.id)).toEqual([
      a.body.id,
    ]);
    expect((await page(`?orgId=${orgId}&status=live`)).items.map((e) => e.id)).toEqual([b.body.id]);
    const one = await page(`?orgId=${orgId}&limit=1`);
    expect(one.nextCursor).toBe(b.body.id);
    expect((await page(`?orgId=${orgId}&limit=1&cursor=${one.nextCursor}`)).items[0]?.id).toBe(
      a.body.id,
    );
    expect((await page(`?orgId=${orgId}&q=b`)).items.map((e) => e.id)).toEqual([b.body.id]);
  });

  it('validates the window, the templates and the match input', async () => {
    expect((await create({ closesAt: clock.now() - 2 * HOUR })).res.status).toBe(422);
    expect(
      (
        await create({
          templateIds: [
            await template(orgId, {
              scan: { actions: [{ id: 'add', label: 'Add', kind: 'add' }] },
            }),
          ],
        })
      ).res.status,
    ).toBe(422);
    const noInput = await create({ match: { input: 'nope', values: ['x'] } });
    expect(noInput.res.status).toBe(422);
    const nested = await template(orgId, {
      inputs: {
        type: 'object',
        properties: { tags: { type: 'array' }, memberName: { type: 'string' } },
      },
    });
    const arr = await create({ templateIds: [nested], match: { input: 'tags', values: ['x'] } });
    expect(arr.res.status).toBe(422);
    expect(await codeOf(arr.res)).toBe('EVENT_MATCH_INPUT');
    expect(
      (await create({ match: { input: 'memberName', values: ['Alex Morgan'] } })).res.status,
    ).toBe(201);
    const bad = await call('PATCH', `/${(await create()).body.id}`, {
      closesAt: clock.now() - 5 * HOUR,
    });
    expect(bad.status).toBe(422);
  });

  it('requires usable legacy Wallet evidence and validates every pinned legacy version', async () => {
    const legacy = makeTemplate({ id: f.ids.id(), orgId });
    await persistTemplate(f, legacy.resolved, { registry: legacy.registry });
    const missing = await create({ templateIds: [legacy.resolved.id] });
    expect(missing.res.status).toBe(422);
    expect(await codeOf(missing.res)).toBe('EVENT_TEMPLATE_RELEASE_REQUIRED');

    const first = await makeLegacyScanPass(f, { orgId, template: legacy.resolved });
    expect((await create({ templateIds: [legacy.resolved.id] })).res.status).toBe(201);
    await run(env.DB, 'UPDATE passes SET test_data_quarantined=1 WHERE id=?', [first.id]);
    const quarantined = await create({ templateIds: [legacy.resolved.id] });
    expect(quarantined.res.status).toBe(422);
    expect(await codeOf(quarantined.res)).toBe('EVENT_TEMPLATE_RELEASE_REQUIRED');
    await run(env.DB, 'UPDATE passes SET test_data_quarantined=0 WHERE id=?', [first.id]);

    const secondVersion = makeTemplate({
      id: legacy.resolved.id,
      orgId,
      version: 'legacy-v2',
    });
    Object.assign(secondVersion.resolved.manifest, {
      scan: { actions: [{ id: 'add', label: 'Add', kind: 'add' as const }] },
    });
    await persistTemplate(f, secondVersion.resolved, { registry: secondVersion.registry });
    await makeLegacyScanPass(f, { orgId, template: secondVersion.resolved });
    const mixed = await create({ templateIds: [legacy.resolved.id] });
    expect(mixed.res.status).toBe(422);
    expect(await codeOf(mixed.res)).toBe('EVENT_TEMPLATE_NO_CHECK_IN');
  });

  it("another org's templates are a 404", async () => {
    const other = await makeOrg(f);
    const theirs = await template(other.id);
    expect((await create({ templateIds: [theirs] })).res.status).toBe(404);
    const { body } = await create();
    expect((await call('PATCH', `/${body.id}`, { templateIds: [theirs] })).status).toBe(404);
  });
});
