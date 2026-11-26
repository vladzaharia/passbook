import { AppError, ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { emailPlatformAdmins } from './alerts.ts';
import { probeApns } from './apns-probe.ts';
import { abandonPendingCertificate } from './cert-history.ts';
import { beginStep, loadRun } from './provision-run.ts';
import { countAscIssued, getCertificateRow } from './repo-certificates.ts';
import { finishRun } from './repo-runs.ts';

const FAIL_ACTION = {
  provision: 'identity.provision_failed',
  rotate: 'identity.rotation_failed',
  revoke: 'identity.revoke_failed',
} as const;
const FAIL_CODE = {
  provision: 'IDENTITY_PROVISION_FAILED',
  rotate: 'IDENTITY_ROTATION_FAILED',
  revoke: 'IDENTITY_REVOKE_FAILED',
} as const;
const CODE = /^([A-Z][A-Z0-9_]+): /;

/** The stable code of a failure: an AppError's own, or the prefix a NonRetryableError carries. */
export function failureCode(cause: unknown): string {
  if (cause instanceof AppError) return cause.code;
  const prefix = cause instanceof Error ? CODE.exec(cause.message)?.[1] : undefined;
  return prefix ?? 'IDENTITY_RUN_FAILED';
}

/**
 * The run ends `failed` with the code, an audit row and an error log (never the message: it can echo
 * Apple's response). A rotation's unused key is deleted. The planner starts a new run tomorrow.
 */
export async function failRun(ctx: ServiceContext, runId: string, cause: unknown): Promise<void> {
  const { run, ref } = await loadRun(ctx, runId);
  if (run.state !== 'queued' && run.state !== 'running' && run.state !== 'waiting') return;
  const code = failureCode(cause);
  if ((run.kind === 'rotate' || code === 'ASC_REFUSED') && ref.certId) {
    const pending = await getCertificateRow(ctx.env.DB, ref.certId);
    // A CSR Apple refused is never retried: the next run makes a fresh key. A certificate Apple already
    // issued keeps its key, so the next run adopts it.
    if (pending?.state === 'pending' && !pending.asc_certificate_id)
      await abandonPendingCertificate(ctx, pending.id);
  }
  await finishRun(ctx.env.DB, runId, 'failed', code, ctx.clock.now());
  const identityId = ref.identityId ?? (run.target_type === 'identity' ? run.target_id : null);
  await recordAudit(ctx, {
    actorType: 'system',
    orgId: run.org_id,
    action: FAIL_ACTION[run.kind],
    targetType: identityId ? 'identity' : 'org',
    targetId: identityId ?? run.target_id,
    detail: { runId, step: run.step, code },
  });
  ctx.log.error(FAIL_ACTION[run.kind], {
    runId,
    identityId,
    step: run.step,
    code: FAIL_CODE[run.kind],
    reason: code,
  });
}

/** Push still works with the new certificate? A failure alerts but never rolls back: the push key is independent. */
export async function postCheck(ctx: ServiceContext, runId: string): Promise<void> {
  const { run, ref } = await beginStep(ctx, runId, 'post-check');
  const identityId = ref.identityId ?? run.target_id;
  let failing: boolean;
  try {
    failing = (await probeApns(ctx, null, identityId)).health === 'failing';
  } catch (error) {
    ctx.log.warn('identity.apns_probe_failed', { identityId, code: 'PROBE_ERROR', error });
    failing = true;
  }
  if (!failing) return;
  ctx.log.error('identity.push_after_rotation_failed', {
    identityId,
    code: 'IDENTITY_PUSH_AFTER_ROTATION',
  });
  await emailPlatformAdmins(
    ctx,
    'Pass type push check failed',
    `The push check failed after the certificate for ${identityId} changed. Check the identity.`,
  );
}

/** The provisioner's own cap per pass type (workers/apple-provisioner/src/ledger.ts); this one stops the run before an order is refused. */
const CAP = 2;
const CAP_WINDOW_MS = 30 * 86_400_000;

/** Apple orders: fail closed, with an alert, when an identity already got `CAP` certificates in 30 days. */
export async function assertIssueBudget(ctx: ServiceContext, runId: string): Promise<void> {
  const { run, ref } = await loadRun(ctx, runId);
  const identityId = ref.identityId ?? run.target_id;
  const n = await countAscIssued(ctx.env.DB, identityId, ctx.clock.now() - CAP_WINDOW_MS);
  if (n < CAP) return;
  ctx.log.error('identity.cert_cap', { identityId, issued: n, code: 'IDENTITY_CERT_CAP' });
  await emailPlatformAdmins(
    ctx,
    'Certificate orders stopped',
    `${identityId} got ${n} certificates in 30 days. Automatic orders are stopped. Check the pass type in the developer portal.`,
  );
  throw new ConflictError(
    'Too many certificates were issued for this identity.',
    'IDENTITY_CERT_CAP',
  );
}
