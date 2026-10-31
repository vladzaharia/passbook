import { PassBuildError } from '../../../passkit/build.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { getPointer } from '../../connectors/lib/pointer.ts';
import type { RecordResult, UpstreamRecord } from '../../connectors/types.ts';
import { AppError, ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import { type ConnectionRow, getGeneration } from './repo.ts';
import { getPassByRef, markPassSyncError, markPassSynced, type SyncPass } from './repo-passes.ts';

export type Outcome =
  | 'changed'
  | 'unchanged'
  | 'created'
  | 'missing'
  | 'unlinked'
  | 'invalid'
  /** Lost a publish race; the pass is untouched and stays due. */
  | 'deferred'
  /** The connection changed mid-step; nothing was written. */
  | 'fenced';

export interface Totals {
  seen: number;
  changed: number;
  created: number;
  missing: number;
  errors: number;
}

export const emptyTotals = (): Totals => ({
  seen: 0,
  changed: 0,
  created: 0,
  missing: 0,
  errors: 0,
});

export function addOutcome(t: Totals, outcome: Outcome): void {
  t.seen += 1;
  if (outcome === 'changed') t.changed += 1;
  else if (outcome === 'created') t.created += 1;
  else if (outcome === 'missing') t.missing += 1;
  else if (outcome === 'invalid') t.errors += 1;
}

export type Incoming =
  | { kind: 'record'; record: UpstreamRecord; holderEmail?: string | undefined }
  | { kind: 'missing' }
  | { kind: 'unchanged' };

export function fromResult(result: RecordResult): Incoming {
  if (result.status === 'ok') {
    return { kind: 'record', record: result.record, holderEmail: result.holderEmail };
  }
  return result.status === 'not_found' ? { kind: 'missing' } : { kind: 'unchanged' };
}

function holderEmailOf(
  conn: ConnectionRow,
  incoming: { record: UpstreamRecord; holderEmail?: string | undefined },
) {
  const direct = strictEmail(incoming.holderEmail);
  if (direct) return direct;
  return conn.holderEmailField
    ? strictEmail(getPointer(incoming.record, conn.holderEmailField))
    : null;
}

const MAX_SAMPLES = 5;
const SAMPLE_MAX = 300;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_]{1,39}$/.test(code) ? code : 'RECORD_ERROR';
}

/** `ref: CODE path message; ...` for one failed record. */
export function describeFailure(ref: string, error: unknown): string {
  const issues: { path?: string | undefined; message: string }[] =
    error instanceof PassBuildError
      ? error.report.issues
      : error instanceof ValidationError
        ? (error.issues ?? [])
        : [];
  const detail = issues
    .slice(0, 3)
    .map((i) => `${i.path ? `${i.path} ` : ''}${i.message}`)
    .join('; ');
  return `${ref}: ${errorCode(error)}${detail ? ` ${detail}` : ''}`.slice(0, SAMPLE_MAX);
}

/**
 * Applies one upstream result to the pass bound to `ref` (or creates one). Record-level problems
 * return 'invalid' and are flagged on the pass; seam failures for one pass never abort the run.
 */
export async function applyIncoming(
  sctx: ServiceContext,
  conn: ConnectionRow,
  ref: string,
  incoming: Incoming,
  options: {
    generation: number;
    cause: 'connection' | 'user_refresh';
    intervalMs: number;
    /** Passes prefetched for this batch, keyed by ref (null = none linked). */
    passes?: Map<string, SyncPass | null>;
    /** Collects the first failing records for the run's error detail. */
    samples?: string[];
  },
): Promise<Outcome> {
  const deps = getDeps();
  const db = sctx.env.DB;
  const now = sctx.clock.now();
  const nextSyncAt = now + options.intervalMs;
  const pass = options.passes?.has(ref)
    ? (options.passes.get(ref) ?? null)
    : await getPassByRef(db, conn.orgId, conn.id, ref);
  const fenced = async (): Promise<boolean> =>
    (await getGeneration(db, conn.id)) !== options.generation;

  if (incoming.kind === 'unchanged') {
    if (pass) await markPassSynced(db, { passId: pass.id, connectionId: conn.id, now, nextSyncAt });
    return 'unchanged';
  }
  if (incoming.kind === 'missing') {
    if (!pass) return 'unlinked';
    if (conn.onMissing === 'keep') {
      await markPassSynced(db, { passId: pass.id, connectionId: conn.id, now, nextSyncAt });
      return 'unchanged';
    }
    if (await fenced()) return 'fenced';
    await deps.markPassMissing(sctx, pass.id, conn.onMissing);
    return 'missing';
  }

  const fields = applyMapping(conn.mapping, incoming.record);
  const holderEmail = holderEmailOf(conn, incoming);
  const fail = async (error: unknown): Promise<Outcome> => {
    const code = errorCode(error);
    if (pass) {
      await markPassSyncError(db, { passId: pass.id, connectionId: conn.id, code, nextSyncAt });
    }
    if (options.samples && options.samples.length < MAX_SAMPLES) {
      options.samples.push(describeFailure(ref, error));
    }
    sctx.log.warn('connection.record_invalid', { connectionId: conn.id, code });
    return 'invalid';
  };

  try {
    if (pass) {
      const merged = { ...pass.personalization, ...fields } as Record<string, Json>;
      await deps.validateFields(
        sctx,
        { id: pass.templateId, version: pass.templateVersion },
        merged,
      );
      const result = await deps.applyConnectionRecord(sctx, {
        passId: pass.id,
        connectionId: conn.id,
        generation: options.generation,
        fields,
        holderEmail,
        cause: options.cause,
      });
      await markPassSynced(db, { passId: pass.id, connectionId: conn.id, now, nextSyncAt });
      return result.changed ? 'changed' : 'unchanged';
    }
    if (!conn.autoCreate || !conn.defaultTemplateId) return 'unlinked';
    await deps.validateFields(sctx, { id: conn.defaultTemplateId, version: null }, fields);
    if (await fenced()) return 'fenced';
    await deps.createPassFromConnection(sctx, {
      orgId: conn.orgId,
      templateId: conn.defaultTemplateId,
      connectionId: conn.id,
      externalRef: ref,
      fields,
      holderEmail,
      sendEmail: conn.autoEmail && holderEmail !== null,
    });
    return 'created';
  } catch (error) {
    if (error instanceof ConflictError && error.code === 'HOLDER_OWNED') {
      // The publish went through; only the holder assignment lost to an owner.
      if (pass)
        await markPassSynced(db, { passId: pass.id, connectionId: conn.id, now, nextSyncAt });
      return pass ? 'changed' : 'created';
    }
    if (error instanceof ConflictError && error.code === 'PASS_CONFLICT') {
      sctx.log.info('connection.record_deferred', { connectionId: conn.id });
      return 'deferred';
    }
    // Only deterministic record problems flag the pass; anything else retries the step or job.
    if (error instanceof PassBuildError || error instanceof AppError) return fail(error);
    throw error;
  }
}
