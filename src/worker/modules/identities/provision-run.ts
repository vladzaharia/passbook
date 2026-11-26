import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { enterStep, getRun, patchRunRef, type RunRow } from './repo-runs.ts';

/** What a run remembers between steps. Public values only: CSR, certificate, Apple ids. */
export interface RunRef {
  requestedHandle?: string;
  handle?: string;
  /** Platform provision runs: which of the platform's own identities this run sets up. */
  platformSlot?: 'root' | 'devtest';
  ascPassTypeId?: string;
  identityId?: string;
  certId?: string;
  csrDerB64?: string;
  ascCertificateId?: string;
  certDerB64?: string;
  /** Audit actions already written for this run, so a retried step writes each once. */
  audited?: Record<string, true>;
}

export interface LoadedRun {
  run: RunRow;
  ref: RunRef;
}

export async function loadRun(ctx: ServiceContext, runId: string): Promise<LoadedRun> {
  const run = await getRun(ctx.env.DB, runId);
  if (!run) throw new NotFoundError('Identity run not found.', 'IDENTITY_RUN_NOT_FOUND');
  return { run, ref: run.external_ref ? (JSON.parse(run.external_ref) as RunRef) : {} };
}

/** Records the step on the run. Refuses a run that is finished or cancelled. */
export async function beginStep(
  ctx: ServiceContext,
  runId: string,
  step: string,
): Promise<LoadedRun> {
  if (!(await enterStep(ctx.env.DB, runId, step, ctx.clock.now())))
    throw new ConflictError('This run is no longer open.', 'IDENTITY_RUN_CLOSED');
  return loadRun(ctx, runId);
}

export function patchRef(ctx: ServiceContext, runId: string, patch: Partial<RunRef>) {
  return patchRunRef(ctx.env.DB, runId, patch, ctx.clock.now());
}

/** One audit row per action per run, even when the step that writes it runs twice. */
export async function auditOnce(
  ctx: ServiceContext,
  { run, ref }: LoadedRun,
  action: string,
  detail: Record<string, unknown>,
  targetId: string | null = ref.identityId ??
    (run.target_type === 'identity' ? run.target_id : null),
): Promise<void> {
  if (ref.audited?.[action]) return;
  await recordAudit(ctx, {
    actorType: 'system',
    orgId: run.org_id,
    action,
    targetType: targetId ? 'identity' : 'org',
    targetId: targetId ?? run.target_id,
    detail: { runId: run.id, ...detail },
  });
  await patchRef(ctx, run.id, { audited: { [action]: true } });
}
