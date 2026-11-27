import type { GoogleIssuerRun } from '../../../shared/contracts/wallet-providers.ts';
import {
  ConflictError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
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
import { saveSystemCredential } from './credential-system-save.ts';
import { GoogleWalletError } from './google-errors.ts';
import { getGoogleIssuer, insertGoogleIssuer, listGoogleIssuers } from './google-issuer-rest.ts';
import { managedDeps } from './google-managed-deps.ts';
import { type PlatformAccess, platformAccess } from './google-platform-access.ts';
import { claimIssuer, issuerHash } from './issuer-claims.ts';
import {
  activeOrgGoogle,
  activePlatformGoogle,
  claimedIssuersOf,
  claimRun,
  releaseRun,
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
  input: { orgId: string; createdBy: string | null; keyId?: string },
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
    actorType: input.keyId ? 'api_key' : input.createdBy ? 'user' : 'system',
    actorId: input.keyId ?? input.createdBy,
    orgId: input.orgId,
    action: 'wallet.google_issuer_requested',
    targetType: 'org',
    targetId: input.orgId,
    detail: { runId: id, ...(input.keyId ? { via: 'api' } : {}) },
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
  input: { orgId: string; issuerId: string; adminId: string | null; keyId?: string },
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
  await assertShared(access, input.issuerId);
  await claimIssuer(ctx, {
    issuerId: input.issuerId,
    orgId: input.orgId,
    origin: 'manual',
    owned: false,
  });
  await patchRunRef(db, open.id, { issuerId: input.issuerId, how: 'manual' }, ctx.clock.now());
  if (await resumeRun(db, open.id, ctx.clock.now())) await enqueue(ctx, open.id);
  await recordAudit(ctx, {
    actorType: input.keyId ? 'api_key' : 'user',
    actorId: input.keyId ?? input.adminId,
    orgId: input.orgId,
    action: 'wallet.google_issuer_entered',
    targetType: 'org',
    targetId: input.orgId,
    detail: {
      runId: open.id,
      issuerId: input.issuerId,
      ...(input.keyId ? { via: 'api' } : {}),
    },
  });
  const run = await getRun(db, open.id, GOOGLE);
  if (!run) throw new NotFoundError();
  return runDto(run);
}

/** The issuer must be one PassBook's service account can act for. */
async function assertShared(access: PlatformAccess, issuerId: string): Promise<void> {
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
}

const PERMANENT = new Set([
  'bad_request',
  'unauthorized',
  'invalid_credentials',
  'invalid_input',
  'conflict',
]);
const LEASE_MS = 5 * 60_000;

/**
 * The `wallet.google_issuer` job. One job holds the run at a time (a lease), and each step records what
 * it did, so a retry after a crash picks up where it stopped. An issuer is adopted only when the claims
 * table says PassBook made it for this org, never by its name. It is inserted only when none exists, and
 * claimed for the org the moment Google answers. A 403 on insert means PassBook is not a trusted
 * aggregator yet: the run parks for a platform admin.
 */
export async function runManagedIssuer(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const claim = await claimRun(db, runId, ctx.clock.now(), LEASE_MS);
  if (claim === 'closed') return;
  if (claim === 'busy')
    throw new UnavailableError('Another job holds this run.', 'WALLET_RUN_BUSY');
  try {
    await work(ctx, runId);
  } catch (error) {
    await releaseRun(db, runId);
    if (error instanceof GoogleWalletError && PERMANENT.has(error.code))
      return void (await fail(ctx, runId, `GOOGLE_${error.code.toUpperCase()}`, error));
    throw error;
  }
  await releaseRun(db, runId);
}

async function work(ctx: ServiceContext, runId: string): Promise<void> {
  const db = ctx.env.DB;
  const run = await getRun(db, runId, GOOGLE);
  const orgId = run?.org_id;
  if (!run || !orgId) return;
  const now = () => ctx.clock.now();
  await enterStep(db, runId, 'load', now());
  const org = await getOrgRow(db, orgId);
  if (org?.status !== 'active') return void (await fail(ctx, runId, 'ORG_NOT_ACTIVE'));
  const access = await platformAccess(ctx, MODE);
  const call = { accessToken: access.accessToken, fetcher: managedDeps().fetcher() };
  let ref = refOf(run);
  const name = ref.name ?? issuerName(org.name);

  if (!ref.issuerId) {
    await enterStep(db, runId, 'find', now());
    const listed = new Set((await listGoogleIssuers(call)).map((i) => i.issuerId));
    const mine = (await claimedIssuersOf(db, orgId)).find((c) => listed.has(c.issuer_id));
    if (mine) ref = { ...ref, issuerId: mine.issuer_id, how: 'adopted' };
  }
  if (!ref.issuerId) {
    await enterStep(db, runId, 'insert', now());
    try {
      const made = await insertGoogleIssuer(call, name);
      await claimIssuer(ctx, { issuerId: made.issuerId, orgId, origin: 'created', owned: false });
      ref = { ...ref, issuerId: made.issuerId, how: 'inserted' };
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
  if (existing && existing.identity_hash !== (await issuerHash(issuerId)))
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
}

async function fail(ctx: ServiceContext, runId: string, code: string, error?: unknown) {
  await finishRun(ctx.env.DB, runId, 'failed', code, ctx.clock.now());
  ctx.log.error('wallet.google_issuer_failed', { runId, code, ...(error ? { error } : {}) });
}
