import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makePass,
  makeTemplate,
  makeUser,
  type OrgRow,
  persistTemplate,
} from '../../../../test/helpers/index.ts';
import { PassBuildError } from '../../../passkit/build.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import type { Job } from '../../jobs/types.ts';
import { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { nullLogger } from '../../platform/log.ts';
import { createJobContext, type ServiceContext } from '../../platform/service-context.ts';
import { insertRefreshPush } from '../delivery/repo-outbox-refresh.ts';
import {
  ensureCredentialRefKeyset,
  requireCredentialRefKeyset,
} from '../passes/credential-keyset.ts';
import { requireApprovedRelease } from '../templates/releases.ts';
import { type ConnectionDeps, resetDeps, setDeps } from './deps.ts';
import { getConnection } from './repo.ts';
import { seedPass } from './repo-test-pass-fixtures.ts';
import { passRelease } from './runtime-fixtures.ts';
import * as service from './service.ts';

type Create = Parameters<typeof service.create>[2];

export interface Seams {
  applied: Parameters<ConnectionDeps['applyConnectionRecord']>[1][];
  createAttempts: Parameters<ConnectionDeps['createPassFromConnection']>[1][];
  release: { id: string; generation: number; version: string };
  releaseLookups: { templateId: string; orgId: string; mode: string; provider: string }[];
  created: Parameters<ConnectionDeps['createPassFromConnection']>[1][];
  missing: { passId: string; mode: 'flag' | 'void' }[];
  pushes: { passId: string; reason: string }[];
  jobs: Job[];
  /** What applyConnectionRecord reports. */
  changed: boolean;
  failEnqueue: boolean;
  failPush: boolean;
}

export const publicResolver = { resolve: async () => ['93.184.216.34'] };

export interface Kit extends Fixtures {
  sctx: ServiceContext;
  org: OrgRow;
  templateId: string;
  credentialKeysetCommitment: string;
  seams: Seams;
  actor: { type: 'user'; id: string };
}

/** The fake pass service's approved template requires a non-empty memberName. */
function validateTestFields(fields: Record<string, unknown>): void {
  if (typeof fields.memberName !== 'string' || fields.memberName === '') {
    throw new PassBuildError('INVALID_INPUT', 'The pass input is invalid.', []);
  }
}

/** Env, org, persisted template and fake seams (passes, delivery, queue, DNS). */
export async function makeKit(options: { realReleases?: boolean } = {}): Promise<Kit> {
  const env = await makeEnv({ KEK_V1: btoa('0123456789abcdef0123456789abcdef') });
  const credentialKeysetCommitment = await ensureCredentialRefKeyset(env.DB, env);
  const clock = new ManualClock();
  const f = fixtures(env, clock);
  const sctx = createJobContext(env, 'connection-test', { clock, log: nullLogger });
  const org = await makeOrg(f);
  const user = await makeUser(f);
  const template = makeTemplate({ id: `tpl-${org.id.slice(-8)}`, orgId: org.id });
  await persistTemplate(f, template.resolved, { registry: template.registry });
  const seams: Seams = {
    applied: [],
    createAttempts: [],
    release: { id: `release-${org.id}`, generation: 1, version: template.resolved.version },
    releaseLookups: [],
    created: [],
    missing: [],
    pushes: [],
    jobs: [],
    changed: true,
    failEnqueue: false,
    failPush: false,
  };
  resetDeps();
  setDeps({
    requireApprovedRelease: options.realReleases
      ? requireApprovedRelease
      : async (_ctx, templateId, orgId, mode, provider) => {
          seams.releaseLookups.push({ templateId, orgId, mode, provider });
          return {
            ...seams.release,
            templateId,
            orgId,
            mode,
            provider,
            candidateHash: 'a'.repeat(64),
            source: 'approved' as const,
            action: 'release' as const,
            previousReleaseId: null,
            createdBy: user.id,
            createdAt: clock.now(),
            candidateId: `candidate-${org.id}`,
            approvalId: `approval-${org.id}`,
          };
        },
    applyConnectionRecord: async (ctx, input) => {
      const connection = await getConnection(ctx.env.DB, input.connectionId);
      if (
        !connection ||
        connection.mode !== input.expectedConnectionMode ||
        input.credentialKeysetCommitment !== (await requireCredentialRefKeyset(ctx.env.DB, ctx.env))
      ) {
        throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
      }
      seams.applied.push(input);
      return {
        changed: seams.changed,
        version: input.expectedVersion,
        ...(await passRelease(ctx, input.passId)),
        identityId: input.identityId,
        ownerUserId: input.ownerUserId,
        linkGeneration: input.linkGeneration,
        credentialGeneration: input.credentialGeneration,
        lifecycleGeneration: input.lifecycleGeneration,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
        transferPending: false as const,
        pushQueued: seams.changed,
      };
    },
    createPassFromConnection: async (ctx, input) => {
      seams.createAttempts.push(input);
      const expected = input.expectedRelease;
      if (!expected) {
        throw new ConflictError(
          'The approved release is unavailable.',
          'TEMPLATE_RELEASE_REQUIRED',
        );
      }
      const release = options.realReleases
        ? await requireApprovedRelease(ctx, input.templateId, input.orgId, input.mode, 'apple')
        : seams.release;
      if (
        Object.keys(expected).length !== 3 ||
        expected.id !== release.id ||
        expected.generation !== release.generation ||
        expected.version !== release.version
      ) {
        throw new ConflictError('The approved release changed.', 'TEMPLATE_RELEASE_CONFLICT');
      }
      validateTestFields(input.fields);
      const connection = await getConnection(ctx.env.DB, input.connectionId);
      if (
        !connection?.enabled ||
        connection.orgId !== input.orgId ||
        connection.generation !== input.generation ||
        connection.mode !== input.expectedConnectionMode ||
        input.credentialKeysetCommitment !== (await requireCredentialRefKeyset(ctx.env.DB, ctx.env))
      ) {
        throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
      }
      seams.created.push(input);
      return { passId: input.reservedPassId ?? `new-${input.externalRef}` };
    },
    markPassMissing: async (ctx, input, mode) => {
      const connection = await getConnection(ctx.env.DB, input.connectionId);
      if (
        !connection ||
        connection.mode !== input.expectedConnectionMode ||
        input.credentialKeysetCommitment !== (await requireCredentialRefKeyset(ctx.env.DB, ctx.env))
      ) {
        throw new ConflictError('The connection changed. Retry.', 'PASS_CONFLICT');
      }
      seams.missing.push({ passId: input.passId, mode });
      return {
        version: input.expectedVersion,
        ...(await passRelease(ctx, input.passId)),
        identityId: input.identityId,
        ownerUserId: input.ownerUserId,
        linkGeneration: input.linkGeneration,
        credentialGeneration: input.credentialGeneration,
        lifecycleGeneration: input.lifecycleGeneration,
        credentialKeysetCommitment: input.credentialKeysetCommitment,
        transferPending: false as const,
        pushQueued: mode === 'void',
      };
    },
    enqueueRefreshPush: async (ctx, snapshot) => {
      if (seams.failPush) throw new Error('push down');
      if (!(await insertRefreshPush(ctx, snapshot, `test-push:${ctx.ids.id()}`, ctx.clock.now())))
        return false;
      seams.pushes.push({ passId: snapshot.passId, reason: 'refresh' });
      return true;
    },
    enqueueJob: async (_ctx, job) => {
      if (seams.failEnqueue) throw new Error('queue down');
      seams.jobs.push(job);
    },
    validateFields: async (_ctx, _template, fields) => validateTestFields(fields),
    sleep: async () => {},
    resolver: publicResolver,
  });
  return {
    ...f,
    sctx,
    org,
    templateId: template.resolved.id,
    credentialKeysetCommitment,
    seams,
    actor: { type: 'user', id: user.id },
  };
}

/** Seed an accepted invitation and its immutable membership without granting platform privileges. */
export async function addMembership(
  kit: Kit,
  userId: string,
  roles: OrgRole[],
  orgId = kit.org.id,
): Promise<string> {
  const invitationId = kit.ids.id();
  const membershipId = kit.ids.id();
  const now = kit.clock.now();
  await run(
    kit.env.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, JSON.stringify(roles), kit.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    kit.env.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

export function demoInput(kit: Kit, overrides: Partial<Create> = {}): Create {
  return {
    orgId: kit.org.id,
    connectorType: 'demo',
    name: 'Demo',
    config: { count: 3 },
    mode: 'poll',
    ...overrides,
  } as Create;
}

export async function createDemo(kit: Kit, overrides: Partial<Create> = {}) {
  return service.create(kit.sctx, kit.actor, demoInput(kit, overrides));
}

export async function testModePass(kit: Kit, orgId = kit.org.id) {
  return seedPass(kit, orgId, 'test');
}

/** A pass bound to `ref` on the connection. */
export async function linkedPass(
  kit: Kit,
  connectionId: string,
  ref: string,
  orgId = kit.org.id,
  mode: 'live' | 'test' = 'live',
  holder?: { ownerUserId: string; holderEmail: string },
  reservedPassId?: string,
) {
  if (mode === 'test' || holder || reservedPassId !== undefined) {
    return seedPass(kit, orgId, mode, holder, { connectionId, ref }, reservedPassId);
  }
  const template = makeTemplate({ id: kit.templateId, orgId });
  const pass = await makePass(kit, { orgId, template: template.resolved });
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connectionId,
    ref,
    pass.id,
  ]);
  return pass;
}

/** A service context whose CONNECTION_SYNC binding records instead of starting workflows. */
export function withWorkflow(
  kit: Kit,
  create?: (options: unknown) => Promise<void>,
  /** What `get(id).status()` reports; unset makes `get` throw, like an unknown instance. */
  status?: () => string,
) {
  const created: { id: string; params: Record<string, unknown> }[] = [];
  const binding = {
    get: async () => {
      if (!status) throw new Error('instance.not_found');
      return { status: async () => ({ status: status() }) };
    },
    create: async (options: { id: string; params: Record<string, unknown> }) => {
      if (create) await create(options);
      created.push(options);
    },
  };
  const sctx = {
    ...kit.sctx,
    env: { ...kit.env, CONNECTION_SYNC: binding },
  } as unknown as ServiceContext;
  return { sctx, created };
}
