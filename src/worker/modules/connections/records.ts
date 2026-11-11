import { PassBuildError } from '../../../passkit/build.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { getPointer } from '../../connectors/lib/pointer.ts';
import type { RecordResult, UpstreamRecord } from '../../connectors/types.ts';
import { AppError, ConflictError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import { type ConnectionRow, getConnection } from './repo.ts';
import {
  getPassByRef,
  hasBinding,
  markPassSyncError,
  markPassSynced,
  type SyncPass,
  type SyncSnapshot,
  templateScope,
} from './repo-passes.ts';
import { isOrgActive } from '../orgs/active.ts';

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

export interface Applied {
  outcome: Outcome;
  /** Version and status after a successful update of an existing pass. */
  version?: number;
  status?: 'active' | 'voided';
  ownerUserId?: string | null;
  linkGeneration?: number;
}

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
 * Applies one upstream result against the snapshot taken before fetching it.
 * Bookkeeping is guarded by the same pass and connection context as publication.
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
    samples?: string[];
  },
): Promise<Applied> {
  const deps = getDeps();
  const db = sctx.env.DB;
  const now = sctx.clock.now();
  const nextSyncAt = now + options.intervalMs;
  const pass = options.passes?.has(ref)
    ? (options.passes.get(ref) ?? null)
    : await getPassByRef(db, conn.orgId, conn.id, ref);
  const snapshot: SyncSnapshot | null = pass
    ? {
        passId: pass.id,
        orgId: conn.orgId,
        mode: 'live',
        status: 'active',
        expectedVersion: pass.version,
        ownerUserId: pass.ownerUserId,
        linkGeneration: pass.linkGeneration,
        connectionId: conn.id,
        externalRef: ref,
        generation: options.generation,
      }
    : null;
  const fenced = async (): Promise<boolean> => {
    const current = await getConnection(db, conn.id);
    return !current?.enabled || current.orgId !== conn.orgId ||
      current.generation !== options.generation || !(await isOrgActive(sctx, conn.orgId));
  };
  const synced = async (p: SyncSnapshot): Promise<Applied> =>
    (await markPassSynced(db, { ...p, now, nextSyncAt }))
      ? { outcome: 'unchanged', version: p.expectedVersion, status: 'active', ownerUserId: p.ownerUserId, linkGeneration: p.linkGeneration }
      : { outcome: 'fenced' };

  if (await fenced()) return { outcome: 'fenced' };
  if (incoming.kind === 'unchanged') {
    return snapshot ? synced(snapshot) : { outcome: 'unchanged' };
  }
  if (incoming.kind === 'missing') {
    if (!snapshot) return { outcome: 'unlinked' };
    if (conn.onMissing === 'keep') return synced(snapshot);
    try {
      const result = await deps.markPassMissing(sctx, snapshot, conn.onMissing);
      return {
        outcome: 'missing',
        version: result.version,
        status: conn.onMissing === 'void' ? 'voided' : 'active',
        ownerUserId: result.ownerUserId,
        linkGeneration: result.linkGeneration,
      };
    } catch (error) {
      if (error instanceof ConflictError) {
        sctx.log.info('connection.record_fenced', { connectionId: conn.id, code: error.code });
        return { outcome: 'fenced' };
      }
      throw error;
    }
  }

  const fields = applyMapping(conn.mapping, incoming.record);
  const holderEmail = holderEmailOf(conn, incoming);
  const fail = async (error: unknown): Promise<Applied> => {
    const code = errorCode(error);
    if (snapshot && !(await markPassSyncError(db, { ...snapshot, code, nextSyncAt }))) {
      return { outcome: 'fenced' };
    }
    if (options.samples && options.samples.length < MAX_SAMPLES) {
      options.samples.push(describeFailure(ref, error));
    }
    sctx.log.warn('connection.record_invalid', { connectionId: conn.id, code });
    return { outcome: 'invalid', ...(snapshot ? { version: snapshot.expectedVersion, status: 'active' as const, ownerUserId: snapshot.ownerUserId, linkGeneration: snapshot.linkGeneration } : {}) };
  };

  try {
    if (snapshot && pass) {
      const merged = { ...pass.personalization, ...fields } as Record<string, Json>;
      await deps.validateFields(
        sctx,
        { id: pass.templateId, version: pass.templateVersion },
        merged,
      );
      if (await fenced()) return { outcome: 'fenced' };
      const result = await deps.applyConnectionRecord(sctx, {
        ...snapshot,
        fields,
        holderEmail,
        cause: options.cause,
      });
      const marked = await markPassSynced(db, {
        ...snapshot,
        expectedVersion: result.version,
        ownerUserId: result.ownerUserId,
        linkGeneration: result.linkGeneration,
        now,
        nextSyncAt,
      });
      if (!marked) return { outcome: 'fenced' };
      return { outcome: result.changed ? 'changed' : 'unchanged', version: result.version, status: 'active', ownerUserId: result.ownerUserId, linkGeneration: result.linkGeneration };
    }
    if (!conn.autoCreate || !conn.defaultTemplateId) return { outcome: 'unlinked' };
    if (await hasBinding(db, conn.orgId, conn.id, ref)) return { outcome: 'unlinked' };
    const template = await templateScope(db, conn.defaultTemplateId);
    if (!template || template.status !== 'active' || !template.activeVersion ||
        (template.orgId !== null && template.orgId !== conn.orgId)) {
      throw new ValidationError('The connection template is unavailable.', [], 'TEMPLATE_NOT_FOUND');
    }
    await deps.validateFields(sctx, { id: conn.defaultTemplateId, version: template.activeVersion }, fields);
    if (await fenced()) return { outcome: 'fenced' };
    await deps.createPassFromConnection(sctx, {
      orgId: conn.orgId,
      mode: 'live',
      templateId: conn.defaultTemplateId,
      templateVersion: template.activeVersion,
      connectionId: conn.id,
      generation: options.generation,
      externalRef: ref,
      fields,
      holderEmail,
      sendEmail: conn.autoEmail && holderEmail !== null,
    });
    return { outcome: 'created' };
  } catch (error) {
    if (error instanceof ConflictError || (error instanceof AppError && error.code === 'VERSION_CONFLICT')) {
      sctx.log.info('connection.record_fenced', { connectionId: conn.id, code: error.code });
      return { outcome: error.code === 'PASS_CONFLICT' ? 'deferred' : 'fenced' };
    }
    // Only deterministic record problems flag the pass; anything else retries the step or job.
    if (error instanceof PassBuildError || error instanceof AppError) return fail(error);
    throw error;
  }
}
