import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeEach, expect } from 'vitest';
import { z } from 'zod';
import {
  type FakeAuth,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  persistTemplate,
  type SessionFixture,
  type TestTemplate,
} from '../../../../test/helpers/index.ts';
import { ProblemSchema } from '../../../shared/contracts/common.ts';
import { ScanStaffSchema, StaffPinSchema } from '../../../shared/contracts/scanners.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { getStaff } from './repo-staff.ts';
import {
  extendStaffAdminSession,
  insertStaffActivityScan,
  resetStaffAdminFixture,
  type ScanSeed,
  staffBinding,
  staffCredential,
} from './repo-staff-admin-test-fixtures.ts';
import { checkPin } from './staff-pin.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
export const WireStaffSchema = ScanStaffSchema.strict();
const CreatedSchema = z.object({ staff: WireStaffSchema, ...StaffPinSchema.shape }).strict();
const StaffListSchema = z
  .object({ items: z.array(WireStaffSchema), hasMore: z.boolean().optional() })
  .strict();
type Staff = z.infer<typeof ScanStaffSchema>;
type Mode = 'live' | 'test';
type Created = z.infer<typeof CreatedSchema>;

export function setupStaffAdminTestKit() {
  let env: AppEnv;
  let f: Fixtures;
  let clock: ManualClock;
  let fake: FakeAuth;
  let app: OpenAPIHono<AppBindings>;
  let orgId: string;
  let userId: string;
  let sessions: Map<string, SessionFixture>;
  let activityTemplate: TestTemplate;
  let activityPasses: Map<string, { passId: string; templateId: string }>;

  beforeEach(async () => {
    clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
    env = await makeEnv();
    await ensureCredentialRefKeyset(env.DB, env);
    f = fixtures(env, clock);
    fake = fakeAuth(ORIGIN);
    app = createApp({
      stores: { ...fake.stores, sessions: createSessionStore(env, clock) },
      clock,
    });
    await resetStaffAdminFixture(env);
    userId = (await makeUser(f)).id;
    orgId = (await makeOrg(f)).id;
    activityTemplate = makeTemplate({ id: f.ids.id(), orgId: null });
    activityPasses = new Map();
    sessions = new Map();
    await seedAdmin(userId);
  });

  async function seedAdmin(id: string) {
    const session = await makeSession(f, { userId: id, roles: ['admin', 'user'] });
    // Some activity tests advance an hour; keep the fixture session alive for that interval.
    await extendStaffAdminSession(env.DB, id, clock.now() + 24 * 60 * 60_000);
    sessions.set(id, session);
    await grantScanMembership(f, orgId, id);
  }
  async function serviceAuthority(ctx: ServiceContext) {
    const fixture = sessions.get(userId);
    if (!fixture) throw new Error('Missing session fixture');
    const auth = await createSessionStore(env, clock).resolve(fixture.cookieValue);
    if (!auth) throw new Error('Session did not resolve');
    const authority = await tenantAuthorityOf(ctx, auth, orgId, 'scanning:manage');
    if (authority.kind !== 'session') throw new Error('Expected a session authority');
    return { auth, authority };
  }
  const admin = (mode?: Mode, id = userId) => {
    const session = sessions.get(id);
    if (!session) throw new Error('Missing admin session fixture');
    return {
      ...session.headers,
      origin: ORIGIN,
      ...(mode ? { 'x-passbook-mode': mode } : {}),
    };
  };
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = admin(),
  ) =>
    app.request(
      `${ORIGIN}/api/v1/scan-staff${path}`,
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
  const query = (id = orgId) => `?orgId=${encodeURIComponent(id)}`;
  const itemPath = (id: string, org = orgId) => `/${id}${query(org)}`;
  const resetPath = (id: string, org = orgId) => `/${id}/reset-pin${query(org)}`;
  const codeOf = async (res: Response) => ProblemSchema.parse(await res.json()).code;

  async function create(
    name = 'Jordan',
    role: 'door' | 'desk' | 'manager' = 'door',
    org = orgId,
    mode?: Mode,
  ): Promise<Created> {
    const res = await send('POST', '', { orgId: org, name, role }, admin(mode));
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toContain('no-store');
    return CreatedSchema.parse(await res.json());
  }

  async function list(org = orgId, mode?: Mode): Promise<Staff[]> {
    const res = await send('GET', query(org), undefined, admin(mode));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    return StaffListSchema.parse(await res.json()).items;
  }

  async function pinAttempt(staffId: string, pin: string, scannerId: string, org = orgId) {
    const staff = await getStaff(env.DB, org, staffId);
    return checkPin(createServiceContext(env, { clock }), {
      scannerId,
      orgId: org,
      staffId,
      staff,
      pin,
    });
  }

  const binding = (id: string) => staffBinding(env.DB, id);
  const credential = (id: string) => staffCredential(env.DB, id);

  async function seedScan(input: ScanSeed) {
    const id = f.ids.id();
    const scanOrg = input.org ?? orgId;
    const scanMode = input.mode ?? 'live';
    let pass: { passId: string; templateId: string } | undefined;
    if (!input.passless) {
      const key = `${scanOrg}\0${scanMode}`;
      pass = activityPasses.get(key);
      if (!pass) {
        if (activityPasses.size === 0)
          await persistTemplate(f, activityTemplate.resolved, {
            registry: activityTemplate.registry,
          });
        const created = await makePass(f, {
          orgId: scanOrg,
          mode: scanMode,
          template: activityTemplate.resolved,
        });
        pass = { passId: created.id, templateId: activityTemplate.resolved.id };
        activityPasses.set(key, pass);
      }
    }
    await insertStaffActivityScan(env.DB, { id, scanOrg, scanMode, pass, input });
    return id;
  }

  return {
    get env() {
      return env;
    },
    get f() {
      return f;
    },
    get clock() {
      return clock;
    },
    get fake() {
      return fake;
    },
    get orgId() {
      return orgId;
    },
    get userId() {
      return userId;
    },
    admin,
    binding,
    codeOf,
    create,
    credential,
    itemPath,
    list,
    pinAttempt,
    query,
    resetPath,
    seedAdmin,
    seedScan,
    send,
    serviceAuthority,
  };
}
