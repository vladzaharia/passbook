import type { OpenAPIHono } from '@hono/zod-openapi';
import { stagePendingCredentialTransfer } from '../../../../test/helpers/credential-transfer.ts';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeSession,
  makeTemplate,
  makeUser,
  type OrgRow,
  type PassRow,
  persistTemplate,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import {
  type AppleReleaseFixture,
  approveAppleRelease,
} from '../passes/apple-release-test-fixtures.ts';
import { ensureCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { previewAuthorityRaces } from './repo-routes-display-authority-races-test-fixtures.ts';
import { previewAuthorityQueries } from './repo-routes-display-authority-test-fixtures.ts';
import { grantScanMembership } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
type PreviewTarget = { orgId: string; templateId: string; passId: string };

export interface PreviewAuthorityFixture {
  env: AppEnv;
  f: Fixtures;
  clock: ManualClock;
  org: OrgRow;
  otherOrg: OrgRow;
  own: PreviewTarget;
  ownTest: PreviewTarget;
  foreign: PreviewTarget;
  foreignTest: PreviewTarget;
  ownReleaseFixture: AppleReleaseFixture;
  foreignReleaseFixture: AppleReleaseFixture;
  app: OpenAPIHono<AppBindings>;
  memberSession(roles: OrgRole[], orgId?: string, platformAdmin?: boolean): Promise<SessionFixture>;
  seedWalletSnapshot(pass: PassRow, template: ResolvedTemplate): Promise<void>;
  startTransfer(db: D1Database, passId: string): Promise<void>;
  releaseState(passId: string): Promise<{ absent: number; head: string | null } | null>;
  preview(
    target: PreviewTarget,
    headers: Record<string, string>,
    overrides?: Record<string, string>,
    requestEnv?: AppEnv,
  ): Promise<Response>;
  problem(response: Response): Promise<unknown>;
  previewAudits(userId: string): Promise<{ org_id: string; target_id: string }[]>;
  withMutableKeyset(work: (original: string, replacement: string) => Promise<void>): Promise<void>;
  atPreviewKeysetBootstrap(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response>;
  atPreviewRead(
    matches: (sql: string) => boolean,
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response>;
  atPreviewAudit(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
  ): Promise<Response>;
  atPreviewOutputFence(
    intervene: (db: D1Database) => Promise<void>,
    operation: () => Promise<Response>,
    observeBind?: (sql: string, values: readonly unknown[]) => void,
  ): Promise<Response>;
}

export async function createPreviewAuthorityFixture(): Promise<PreviewAuthorityFixture> {
  const clock = new ManualClock();
  const env = await makeEnv();
  const { seedWalletSnapshot, releaseState, previewAudits } = previewAuthorityQueries(env);
  const f = fixtures(env, clock);
  const org = await makeOrg(f);
  const otherOrg = await makeOrg(f);
  const templateFixture = makeTemplate({ id: f.ids.id(), orgId: org.id });
  const template = templateFixture.resolved;
  template.manifest.inputs = {
    type: 'object',
    properties: {
      memberName: { type: 'string' },
      deskNote: { type: 'string', 'x-scan': 'desk' },
      managerNote: { type: 'string', 'x-scan': 'manager' },
    },
  };
  const otherTemplateFixture = makeTemplate({ id: f.ids.id(), orgId: otherOrg.id });
  const otherTemplate = otherTemplateFixture.resolved;
  const ctx = createServiceContext(env, { clock });
  const ownReleaseFixture = { ctx, fx: f, registry: templateFixture.registry };
  const foreignReleaseFixture = { ctx, fx: f, registry: otherTemplateFixture.registry };
  await persistTemplate(f, template, { registry: templateFixture.registry });
  await persistTemplate(f, otherTemplate, { registry: otherTemplateFixture.registry });
  for (const mode of ['live', 'test'] as const) {
    await approveAppleRelease(ownReleaseFixture, {
      orgId: org.id,
      templateId: template.id,
      version: template.version,
      mode,
    });
  }
  await approveAppleRelease(foreignReleaseFixture, {
    orgId: otherOrg.id,
    templateId: otherTemplate.id,
    version: otherTemplate.version,
    mode: 'live',
  });
  const pass = await makePass(f, {
    orgId: org.id,
    template,
    personalization: {
      memberName: 'Alex Morgan',
      deskNote: 'desk-only',
      managerNote: 'manager-only',
    },
  });
  const testPass = await makePass(f, {
    orgId: org.id,
    template,
    mode: 'test',
    personalization: {
      memberName: 'Alex Morgan',
      deskNote: 'desk-only',
      managerNote: 'manager-only',
    },
  });
  const otherPass = await makePass(f, { orgId: otherOrg.id, template: otherTemplate });
  const otherTestPass = await makePass(f, {
    orgId: otherOrg.id,
    template: otherTemplate,
    mode: 'test',
  });
  await seedWalletSnapshot(pass, template);
  await seedWalletSnapshot(otherPass, otherTemplate);
  await seedWalletSnapshot(testPass, template);
  await seedWalletSnapshot(otherTestPass, otherTemplate);
  const own = { orgId: org.id, templateId: template.id, passId: pass.id };
  const ownTest = { orgId: org.id, templateId: template.id, passId: testPass.id };
  const foreign = { orgId: otherOrg.id, templateId: otherTemplate.id, passId: otherPass.id };
  const foreignTest = {
    orgId: otherOrg.id,
    templateId: otherTemplate.id,
    passId: otherTestPass.id,
  };
  let app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(env, clock) },
    clock,
  });

  async function memberSession(
    roles: OrgRole[],
    orgId = org.id,
    platformAdmin = false,
  ): Promise<SessionFixture> {
    const user = await makeUser(f);
    await grantScanMembership(f, orgId, user.id, roles);
    return makeSession(f, {
      userId: user.id,
      roles: platformAdmin ? ['admin', 'user'] : ['user'],
    });
  }

  async function startTransfer(db: D1Database, passId: string): Promise<void> {
    await ensureCredentialRefKeyset(db, env);
    await stagePendingCredentialTransfer(db, passId, {
      id: f.ids.ordered(),
      token: f.ids.token(),
      now: clock.now(),
      targetHolderEmail: 'incoming@example.test',
    });
  }

  function preview(
    target: PreviewTarget,
    headers: Record<string, string>,
    overrides: Record<string, string> = {},
    requestEnv: AppEnv = env,
  ): Promise<Response> {
    const query = new URLSearchParams({ ...target, mode: 'live', role: 'door', ...overrides });
    return Promise.resolve(
      app.request(`${ORIGIN}/api/v1/scan-display/preview?${query}`, { headers }, requestEnv),
    );
  }

  async function problem(response: Response): Promise<unknown> {
    const body = (await response.json()) as { requestId?: string };
    delete body.requestId;
    return body;
  }

  return {
    env,
    f,
    clock,
    org,
    otherOrg,
    own,
    ownTest,
    foreign,
    foreignTest,
    ownReleaseFixture,
    foreignReleaseFixture,
    get app() {
      return app;
    },
    set app(value) {
      app = value;
    },
    memberSession,
    seedWalletSnapshot,
    startTransfer,
    releaseState,
    preview,
    problem,
    previewAudits,
    ...previewAuthorityRaces(env),
  };
}
