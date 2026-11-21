import type { GoogleIssuerRun } from '../../../shared/contracts/wallet-providers.ts';
import { ConflictError, NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import {
  enterStep,
  findOpenRun,
  finishRun,
  getRun,
  insertRun,
  latestRun,
  parkRun,
  patchRunRef,
  type RunRow,
} from '../identities/repo-runs.ts';
import { getOrgRow } from '../orgs/repo.ts';
import { enqueueVersionCheck } from './account-check.ts';
import { credentialIdentityHash } from './account-credential-source.ts';
import { saveSystemCredential } from './credential-system-save.ts';
import { GoogleWalletError } from './google-errors.ts';
import { getGoogleIssuer, insertGoogleIssuer, listGoogleIssuers } from './google-issuer-rest.ts';
import { managedDeps } from './google-managed-deps.ts';
import { type PlatformAccess, platformAccess } from './google-platform-access.ts';
import {
  activeOrgGoogle,
  activePlatformGoogle,
  issuerClaimedElsewhere,
  resumeRun,
} from './repo-google-managed.ts';

const MODE = 'live' as const;
const TARGET = 'wallet_credential' as const;
/** One open run per org: the id keys the unique index of `identity_runs`. */
export const managedTargetId = (orgId: string) => `google:${MODE}:${orgId}`;
export const issuerName = (orgName: string) => `${orgName} via PassBook`;
const GOOGLE = 'google' as const;

interface Ref {
  name?: string;
  issuerId?: string;
  how?: 'inserted' | 'adopted' | 'manual';
}

const refOf = (run: RunRow): Ref => (run.external_ref ? (JSON.parse(run.external_ref) as Ref) : {});

export function runDto(run: RunRow): GoogleIssuerRun {
  return {
    runId: run.id,
    state: run.state,
    step: run.step,
    waitingFor: run.waiting_for,
    errorCode: run.error_code,
    issuerId: refOf(run).issuerId ?? null,
    updatedAt: run.updated_at,
  };
}

/** Starts the run that gives the org a child issuer, or returns the open one. */
export async function startManagedIssuer(
  ctx: ServiceContext,
  input: { orgId: string; createdBy: string | null },
): Promise<{ run: GoogleIssuerRun; created: boolean }> {
  const db = ctx.env.DB;
  const org = await getOrgRow(db, input.orgId);
  if (!org || org.status === 'deleted')
    throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  if (await activeOrgGoogle(db, input.orgId, MODE))
    throw new ConflictError(
      'This organization already has a Google issuer.',
      'WALLET_ISSUER_EXISTS',
    );
  if (!(await activePlatformGoogle(db, MODE)))
    throw new ConflictError(
      "PassBook's Google credential is not set up.",
      'WALLET_PLATFORM_CREDENTIAL_MISSING',
    );
  const targetId = managedTargetId(input.orgId);
  const id = ctx.ids.id();
  const inserted = await insertRun(db, {
    id,
    provider: GOOGLE,
    orgId: input.orgId,
    kind: 'provision',
    targetType: TARGET,
    targetId,
    createdBy: input.createdBy,
    ref: { name: issuerName(org.name) },
    now: ctx.clock.now(),
  });
  if (!inserted) {
    const open = await findOpenRun(db, TARGET, targetId, 'provision');
    if (open) return { run: runDto(open), created: false };
    return startManagedIssuer(ctx, input);
  }
  await enqueue(ctx, id);
  await recordAudit(ctx, {
    actorType: input.createdBy ? 'user' : 'system',
    actorId: input.createdBy,
    orgId: input.orgId,
    action: 'wallet.google_issuer_requested',
    targetType: 'org',
    targetId: input.orgId,
    detail: { runId: id },
  });
  const run = await getRun(db, id, GOOGLE);
  if (!run) throw new NotFoundError();
  return { run: runDto(run), created: true };
}

async function enqueue(ctx: ServiceContext, runId: string): Promise<void> {
  try {
    await ctx.env.JOBS.send({ kind: 'wallet.google_issuer', runId });
  } catch (error) {
    // No job will pick this run up; closing it frees the open-run index for the next start.
    await finishRun(ctx.env.DB, runId, 'failed', 'WALLET_RUN_UNQUEUED', ctx.clock.now());
    ctx.log.error('wallet.google_issuer_unqueued', { runId, code: 'WALLET_RUN_UNQUEUED', error });
    throw error;
  }
}

export async function latestManagedRun(
  ctx: ServiceContext,
  orgId: string,
): Promise<GoogleIssuerRun | null> {
  const run = await latestRun(ctx.env.DB, TARGET, managedTargetId(orgId), 'provision');
  return run && run.org_id === orgId ? runDto(run) : null;
}

/** A platform admin finishes a parked run with an issuer made in the Console and shared with PassBook. */
export async function completeManualIssuer(
  ctx: ServiceContext,
  input: { orgId: string; issuerId: string; adminId: string },
): Promise<GoogleIssuerRun> {
  const db = ctx.env.DB;
  const open = await findOpenRun(db, TARGET, managedTargetId(input.orgId), 'provision');
  if (
    !open ||
    open.org_id !== input.orgId ||
    open.state !== 'waiting' ||
    open.waiting_for !== 'google_manual_issuer'
  )
    throw new ConflictError(
      'No issuer is waiting for this organization.',
      'WALLET_ISSUER_NOT_WAITING',
    );
  const access = await platformAccess(ctx, MODE);
  await assertShared(ctx, access, input.issuerId, input.orgId);
  await patchRunRef(db, open.id, { issuerId: input.issuerId, how: 'manual' }, ctx.clock.now());
  if (await resumeRun(db, open.id, ctx.clock.now())) await enqueue(ctx, open.id);
  await recordAudit(ctx, {
    actorType: 'user',
    actorId: input.adminId,
    orgId: input.orgId,
    action: 'wallet.google_issuer_entered',
    targetType: 'org',
    targetId: input.orgId,
    detail: { runId: open.id, issuerId: input.issuerId },
  });
  const run = await getRun(db, open.id, GOOGLE);
  if (!run) throw new NotFoundError();
  return runDto(run);
}

/** The issuer must be one PassBook's service account can act for, and no other org's. */
async function assertShared(
  ctx: ServiceContext,
  access: PlatformAccess,
  issuerId: string,
  orgId: string,
): Promise<void> {
  try {
    await getGoogleIssuer(
      { accessToken: access.accessToken, fetcher: managedDeps().fetcher() },
      issuerId,
    );
  } catch (error) {
    if (
      error instanceof GoogleWalletError &&
      (error.code === 'forbidden' || error.code === 'not_found')
    )
      throw new ValidationError(
        `Share this issuer with ${access.credentials.serviceAccountEmail} first.`,
        [],
        'GOOGLE_ISSUER_NOT_SHARED',
      );
    throw error;
  }
  if (await claimed(ctx, access, issuerId, orgId))
    throw new ConflictError('Another organization uses this issuer.', 'WALLET_ISSUER_CLAIMED');
}

const hashOf = (access: PlatformAccess, issuerId: string) =>
  credentialIdentityHash({ provider: 'google', credentials: { ...access.credentials, issuerId } });

async function claimed(
  ctx: ServiceContext,
  access: PlatformAccess,
  issuerId: string,
  orgId: string,
) {
  return issuerClaimedElsewhere(ctx.env.DB, await hashOf(access, issuerId), MODE, orgId);
}

const PERMANENT = new Set([
  'bad_request',
  'unauthorized',
  'invalid_credentials',
  'invalid_input',
  'conflict',
]);

/**
 * The `wallet.google_issuer` job. Steps record what they did in the run, so a retry after a crash picks up
 * where it stopped: list the issuers shared with PassBook's service account (adopting the one an earlier
 * attempt made), insert only when none exists, then record it on the org. A 403 on insert means PassBook
 * is not a trusted aggregator yet: the run parks for a platform admin.
 */
export async function runManagedIssuer(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const run = await getRun(db, runId, GOOGLE);
  if (!run || run.state === 'waiting' || !['queued', 'running'].includes(run.state)) return;
  const now = () => ctx.clock.now();
  const orgId = run.org_id;
  if (!orgId) return;
  try {
    if (!(await enterStep(db, runId, 'load', now()))) return;
    const org = await getOrgRow(db, orgId);
    if (org?.status !== 'active') return void (await fail(ctx, runId, 'ORG_NOT_ACTIVE'));
    const access = await platformAccess(ctx, MODE);
    const call = { accessToken: access.accessToken, fetcher: managedDeps().fetcher() };
    let ref = refOf(run);
    const name = ref.name ?? issuerName(org.name);

    if (!ref.issuerId) {
      await enterStep(db, runId, 'find', now());
      for (const issuer of await listGoogleIssuers(call))
        if (issuer.name === name && !(await claimed(ctx, access, issuer.issuerId, orgId))) {
          ref = { ...ref, issuerId: issuer.issuerId, how: 'adopted' };
          break;
        }
    }
    if (!ref.issuerId) {
      await enterStep(db, runId, 'insert', now());
      try {
        ref = {
          ...ref,
          issuerId: (await insertGoogleIssuer(call, name)).issuerId,
          how: 'inserted',
        };
      } catch (error) {
        if (!(error instanceof GoogleWalletError) || error.code !== 'forbidden') throw error;
        await parkRun(db, runId, 'google_manual_issuer', now());
        ctx.log.warn('wallet.google_issuer_parked', {
          runId,
          orgId,
          code: 'GOOGLE_AGGREGATOR_REQUIRED',
        });
        return;
      }
    }
    const issuerId = ref.issuerId;
    if (!issuerId) return void (await fail(ctx, runId, 'WALLET_ISSUER_MISSING'));
    await patchRunRef(db, runId, { name, issuerId, how: ref.how }, now());

    await enterStep(db, runId, 'record', now());
    const existing = await activeOrgGoogle(db, orgId, MODE);
    if (existing && existing.identity_hash !== (await hashOf(access, issuerId)))
      return void (await fail(ctx, runId, 'WALLET_ISSUER_EXISTS'));
    if (!existing) {
      const created = await saveSystemCredential(
        ctx,
        {
          orgId,
          mode: MODE,
          current: null,
          secret: { ...access.credentials, issuerId },
          origin: { provenance: 'managed', signerRef: access.credential.id },
        },
        'issuer_provision',
      );
      if (created.current_version_id)
        await enqueueVersionCheck(ctx, created.id, created.current_version_id);
    }
    await enterStep(db, runId, 'finish', now());
    await finishRun(db, runId, 'succeeded', null, now());
    await recordAudit(ctx, {
      actorType: 'system',
      orgId,
      action: 'wallet.google_issuer_created',
      targetType: 'org',
      targetId: orgId,
      detail: { runId, issuerId, how: ref.how ?? null },
    });
    ctx.log.info('wallet.google_issuer_created', { runId, orgId, how: ref.how });
  } catch (error) {
    if (error instanceof GoogleWalletError && PERMANENT.has(error.code))
      return void (await fail(ctx, runId, `GOOGLE_${error.code.toUpperCase()}`, error));
    throw error;
  }
}

async function fail(ctx: ServiceContext, runId: string, code: string, error?: unknown) {
  await finishRun(ctx.env.DB, runId, 'failed', code, ctx.clock.now());
  ctx.log.error('wallet.google_issuer_failed', { runId, code, ...(error ? { error } : {}) });
}
