import {
  type FakeAuth,
  type Fixtures,
  fakeAuth,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  forceStaffTenantKeyset,
  staffTenantState,
} from './repo-staff-tenant-split-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';

export interface StaffTenantFixture {
  env: AppEnv;
  f: Fixtures;
  clock: ManualClock;
  fake: FakeAuth;
  orgId: string;
  foreignOrgId: string;
  userId: string;
  readonly session: SessionFixture;
  setSession: (replacement: SessionFixture) => void;
  headers: () => Record<string, string>;
  orgQuery: (org?: string) => string;
  staffPath: (id: string, org?: string) => string;
  resetPath: (id: string, org?: string) => string;
  call: (
    method: string,
    path: string,
    body?: unknown,
    requestHeaders?: Record<string, string>,
    requestEnv?: AppEnv,
  ) => Response | Promise<Response>;
  grant: (roles?: OrgRole[]) => Promise<string>;
  state: () => Promise<{ staff: unknown[]; bindings: unknown[]; audits: unknown[] }>;
  forceKeyset: (commitment: string) => Promise<void>;
}

/** Construct a separate harness inside each test's D1-isolated beforeEach. */
export async function makeStaffTenantFixture(): Promise<StaffTenantFixture> {
  const clock = new ManualClock(Date.UTC(2026, 5, 1, 12));
  const env = await makeEnv();
  const f = fixtures(env, clock);
  const fake = fakeAuth(ORIGIN);
  const app = createApp({
    stores: { ...fake.stores, sessions: createSessionStore(env, clock) },
    clock,
  });
  const orgId = (await makeOrg(f)).id;
  const foreignOrgId = (await makeOrg(f)).id;
  const userId = (await makeUser(f)).id;
  let session = await makeSession(f, { userId, roles: ['admin', 'user'] });

  const headers = () => ({ ...session.headers, origin: ORIGIN });
  const orgQuery = (org = orgId) => `?orgId=${encodeURIComponent(org)}`;
  const staffPath = (id: string, org = orgId) => `/${id}${orgQuery(org)}`;
  const resetPath = (id: string, org = orgId) => `/${id}/reset-pin${orgQuery(org)}`;
  const setSession = (replacement: SessionFixture) => {
    session = replacement;
  };

  function call(
    method: string,
    path: string,
    body?: unknown,
    requestHeaders: Record<string, string> = headers(),
    requestEnv: AppEnv = env,
  ) {
    return app.request(
      `${ORIGIN}/api/v1/scan-staff${path}`,
      {
        method,
        headers: {
          ...requestHeaders,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      requestEnv,
    );
  }

  function grant(roles: OrgRole[] = ['org_admin']) {
    return grantScanMembership(f, orgId, userId, roles);
  }

  const state = () => staffTenantState(env);
  const forceKeyset = (commitment: string) => forceStaffTenantKeyset(env, commitment);

  return {
    env,
    f,
    clock,
    fake,
    orgId,
    foreignOrgId,
    userId,
    get session() {
      return session;
    },
    setSession,
    headers,
    orgQuery,
    staffPath,
    resetPath,
    call,
    grant,
    state,
    forceKeyset,
  };
}
