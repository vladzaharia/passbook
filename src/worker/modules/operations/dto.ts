import {
  OPERATION_ACTIVE,
  type OperationDto,
  type OperationResult,
  OperationResultSchema,
  type OperationStep,
  OperationStepSchema,
} from '../../../shared/contracts/operations.ts';
import { OPERATION_COPY } from '../../../shared/copy/operations.ts';
import { stepText } from '../../../shared/operations/text.ts';
import { kindOf } from './kinds.ts';
import type { OperationRow } from './repo.ts';

export function parseSteps(json: string): OperationStep[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((s) => {
      const step = OperationStepSchema.safeParse(s);
      return step.success ? [step.data] : [];
    });
  } catch {
    return [];
  }
}

function parseResult(json: string | null): OperationResult | null {
  if (!json) return null;
  try {
    const parsed = OperationResultSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const isActive = (status: OperationRow['status']) =>
  (OPERATION_ACTIVE as readonly string[]).includes(status);

/** How long a client waits before it asks again: the server's hint. */
function pollAfterMs(status: OperationRow['status']): number {
  if (status === 'waiting') return 60_000;
  return status === 'queued' || status === 'running' ? 1000 : 0;
}

export function errorMessage(code: string, kind: string): string {
  return (
    kindOf(kind)?.errors?.[code] ??
    OPERATION_COPY.errors[code] ??
    OPERATION_COPY.errors.OPERATION_FAILED ??
    ''
  );
}

/** The API view of a row. Words come from the kind's shared copy, so every surface reads the same. */
export function toDto(row: OperationRow): OperationDto {
  const def = kindOf(row.kind);
  const steps = parseSteps(row.steps);
  const current = steps.find((s) => s.key === row.step_key);
  const currentDef = def?.steps.find((s) => s.key === row.step_key);
  const active = isActive(row.status);
  let text: string;
  if (row.status === 'queued') text = OPERATION_COPY.starting;
  else if (row.status === 'succeeded') text = def?.doneTitle ?? def?.title ?? row.kind;
  else if (row.status === 'failed') text = def?.failTitle ?? def?.title ?? row.kind;
  else if (row.status === 'cancelled') text = OPERATION_COPY.stopped;
  else text = current ? stepText(current, currentDef) : (def?.title ?? row.kind);
  const policy = def?.cancel ?? 'never';
  const cancelable =
    active &&
    row.cancel_requested === 0 &&
    (policy === 'queued' ? row.status === 'queued' : policy !== 'never');
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: def?.title ?? row.kind,
    text,
    orgId: row.org_id,
    mode: row.mode,
    target: row.target_type && row.target_id ? { type: row.target_type, id: row.target_id } : null,
    step: row.step_key,
    steps,
    attempt: row.attempt,
    cancelable,
    cancelRequested: row.cancel_requested === 1,
    startedBy: { type: row.actor_type, id: row.actor_id },
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    error: row.error_code
      ? {
          code: row.error_code,
          message: errorMessage(row.error_code, row.kind),
          step: row.error_step,
          retryable: row.error_retryable === 1,
        }
      : null,
    result: parseResult(row.result),
    revision: row.revision,
    pollAfterMs: pollAfterMs(row.status),
  };
}

export const etagOf = (op: Pick<OperationDto, 'id' | 'revision'>) => `"${op.id}:${op.revision}"`;
