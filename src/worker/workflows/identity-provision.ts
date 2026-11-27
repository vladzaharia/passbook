import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { AppleRpc } from '../../../workers/passbook-apple-connector/src/types.ts';
import { ascClient } from '../modules/identities/asc-client.ts';
import { adoptByPubkey } from '../modules/identities/cert-history.ts';
import { passTypeOf } from '../modules/identities/handles.ts';
import { assertIssueBudget, failRun, postCheck } from '../modules/identities/provision-finish.ts';
import { stepHandle } from '../modules/identities/provision-handle.ts';
import {
  identifierOf,
  orgNameOf,
  recordPassType,
} from '../modules/identities/provision-pass-type.ts';
import {
  isPlatformRun,
  resolvePlatformPassType,
  stepOpen,
} from '../modules/identities/provision-platform.ts';
import { beginStep } from '../modules/identities/provision-run.ts';
import {
  issueInput,
  recordIssued,
  stepActivate,
  stepDefault,
  stepKey,
  stepLoad,
  stepValidate,
} from '../modules/identities/provision-steps.ts';
import { getManagedState } from '../modules/identities/repo-provision.ts';
import { enterStep, finishRun, handleOwner, parkRun } from '../modules/identities/repo-runs.ts';
import { stepRevoke } from '../modules/identities/revoke-run.ts';
import type { IdentityProvisionParams } from '../modules/identities/run-start.ts';
import type { Clock } from '../platform/clock.ts';
import type { AppEnv } from '../platform/env.ts';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
} from '../platform/errors.ts';
import { createJobContext, type ServiceContext } from '../platform/service-context.ts';

export type { IdentityProvisionParams };

const RETRY = { retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' } } as const;
/** A run parks while the Apple provisioner is unavailable and retries daily, for at most this many days. */
const MAX_PARK_DAYS = 45;

type StepLike = Pick<WorkflowStep, 'do' | 'sleep'>;

/** Permanent failures stop the step's retries; a rate limit, an upstream error and a lost CAS race retry. */
function permanent(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 429 &&
    error.code !== 'IDENTITY_CHANGED'
  );
}

/**
 * Apple certificates for an identity: `provision` creates the managed pass type and identity for an
 * org (or, with a platform slot, one of the platform's own), `rotate` replaces the certificate of an existing one (design 5.1). Every step reads its inputs
 * from the run row and is safe to run twice, so a retry after a crash adopts what the first attempt
 * left. The App Store Connect key is behind the `APPLE` binding: only this file and `asc-client.ts`
 * may reach it.
 */
export async function runIdentityProvision(
  env: AppEnv,
  params: IdentityProvisionParams,
  step: StepLike,
  exec?: ExecutionContext,
  clock?: Clock,
): Promise<{ state: 'succeeded' | 'failed' }> {
  const { runId } = params;
  const ctx = createJobContext(env, 'identity-provision', {
    ...(clock ? { clock } : {}),
    ...(exec ? { ctx: exec } : {}),
    base: { workflow: 'identity-provision', runId },
  });
  let failure: unknown;

  const guarded = <T>(name: string, fn: () => Promise<T>): Promise<T> =>
    step.do(name, RETRY, async () => {
      failure = undefined;
      try {
        return (await fn()) as never;
      } catch (error) {
        failure = error;
        if (permanent(error)) throw new NonRetryableError(`${error.code}: ${error.message}`);
        throw error;
      }
    }) as Promise<T>;

  /** An Apple call: while the provisioner is unavailable the run parks as `waiting` and tries again tomorrow. */
  async function viaApple<T>(name: string, fn: (rpc: AppleRpc) => Promise<T>): Promise<T> {
    for (let day = 0; day < MAX_PARK_DAYS; day++) {
      const out = await guarded(`${name}-${day}`, async () => {
        try {
          return { parked: false as const, value: await fn(ascClient(env as { APPLE?: unknown })) };
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== 'ASC_UNAVAILABLE') throw error;
          await parkRun(env.DB, runId, 'apple_unavailable', ctx.clock.now());
          ctx.log.warn('identity.apple_unavailable', { runId, code: 'ASC_UNAVAILABLE', day });
          return { parked: true as const };
        }
      });
      if (!out.parked) return out.value;
      await step.sleep(`${name}-wait-${day}`, '1 day');
    }
    throw new NonRetryableError('ASC_UNAVAILABLE: Apple provisioner stayed unavailable.');
  }

  try {
    const start = await guarded('load', () => stepLoad(ctx, runId));
    if (start.done) return { state: 'succeeded' };
    if (start.kind === 'revoke') {
      await viaApple('revoke', (rpc) => stepRevoke(ctx, rpc, runId));
    } else {
      if (start.kind === 'provision' && !start.platform)
        await guarded('handle', () => stepHandle(ctx, runId));
      await viaApple('pass-type', (rpc) => resolvePassType(ctx, rpc, runId));
      await guarded('key', () => stepKey(ctx, runId));
      await viaApple('issue', (rpc) => issue(ctx, rpc, runId));
      await guarded('validate', () => stepValidate(ctx, runId));
      await guarded('activate', () => stepActivate(ctx, runId));
      await viaApple('report', (rpc) => reportActive(ctx, rpc, runId));
      if (start.platform) await guarded('open', () => stepOpen(ctx, runId));
      else if (start.kind === 'provision') await guarded('default', () => stepDefault(ctx, runId));
      await guarded('post-check', () => postCheck(ctx, runId));
    }
    await guarded('finish', async () => {
      // Repeating this step after it succeeded changes nothing: `finishRun` only closes an open run.
      await enterStep(env.DB, runId, 'finish', ctx.clock.now());
      await finishRun(env.DB, runId, 'succeeded', null, ctx.clock.now());
      ctx.log.info('identity.run_succeeded', { runId, kind: start.kind });
    });
    return { state: 'succeeded' };
  } catch (error) {
    const cause = failure ?? error;
    await step.do('fail', () => failRun(ctx, runId, cause));
    return { state: 'failed' };
  }
}

/** Provision: find the pass type (a retry adopts one an earlier attempt created), else create it. Rotate: look up Apple's id. */
async function resolvePassType(ctx: ServiceContext, rpc: AppleRpc, runId: string): Promise<void> {
  const loaded = await beginStep(ctx, runId, 'pass-type');
  const { run, ref } = loaded;
  if (isPlatformRun(run)) return resolvePlatformPassType(ctx, rpc, loaded);
  if (run.kind === 'rotate') {
    const row = await getManagedState(ctx.env.DB, run.target_id);
    if (row?.asc_pass_type_id)
      return void (await recordPassType(ctx, runId, { ascId: row.asc_pass_type_id }));
    const identifier = await identifierOf(ctx, run.target_id);
    const found = await rpc.findPassType(identifier, runId);
    if (!found) throw new NotFoundError('Apple has no such pass type.', 'ASC_NOT_FOUND');
    return recordPassType(ctx, runId, found);
  }
  if (!ref.handle) throw new UnavailableError('The run has no handle.', 'IDENTITY_RUN_INCOMPLETE');
  const identifier = passTypeOf(ref.handle);
  const orgName = await orgNameOf(ctx, run.target_id);
  const created = await rpc.createPassType(ref.handle, `${orgName} (PassBook)`, runId);
  // The provisioner knows no owners: an existing pass type must be the one this org reserved.
  const reserved = await handleOwner(ctx.env.DB, ref.handle);
  if (created.identifier !== identifier || reserved?.orgId !== run.target_id) {
    ctx.log.error('identity.pass_type_mismatch', {
      runId,
      code: 'IDENTITY_PASS_TYPE_MISMATCH',
      outcome: created.outcome,
    });
    throw new ConflictError(
      'Apple returned a pass type this organization did not reserve.',
      'IDENTITY_PASS_TYPE_MISMATCH',
    );
  }
  return recordPassType(ctx, runId, created, 'created');
}

/** List first: a certificate already issued for this CSR's key (an earlier attempt) is adopted, never ordered twice. */
async function issue(ctx: ServiceContext, rpc: AppleRpc, runId: string): Promise<void> {
  const input = await issueInput(ctx, runId);
  if (!input) return;
  const listed = await rpc.listCertificates(input.ascPassTypeId, runId);
  const adopted = await adoptByPubkey(listed, input.pubkeySha256, ctx.log);
  if (!adopted) await assertIssueBudget(ctx, runId);
  const cert =
    adopted ??
    (await rpc.createCertificate(input.ascPassTypeId, input.csrDer, input.nfc, runId).catch((e) => {
      throw csrRefusal(e) ?? e;
    }));
  await recordIssued(ctx, runId, cert);
}

/** Apple answered 400 or 422 to the order: the CSR is bad for good, so the run stops and `failRun` discards its key. */
function csrRefusal(error: unknown): AppError | null {
  if (!(error instanceof AppError) || error.code !== 'ASC_UPSTREAM') return null;
  if (!/Apple answered (400|422)\b/.test(error.message)) return null;
  return new ForbiddenError('Apple refused the certificate request.', 'ASC_REFUSED');
}

/** Tells the provisioner the new certificate is live: until then it refuses to revoke (it fails closed). Safe to repeat. */
async function reportActive(ctx: ServiceContext, rpc: AppleRpc, runId: string): Promise<void> {
  const { ref } = await beginStep(ctx, runId, 'report');
  if (ref.ascCertificateId) await rpc.reportCertificateActive(ref.ascCertificateId, runId);
}

export class IdentityProvision extends WorkflowEntrypoint<AppEnv, IdentityProvisionParams> {
  override async run(
    event: WorkflowEvent<IdentityProvisionParams>,
    step: WorkflowStep,
  ): Promise<void> {
    await runIdentityProvision(this.env, event.payload, step, this.ctx);
  }
}
