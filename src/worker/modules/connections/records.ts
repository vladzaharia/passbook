import type { Json } from '../../../shared/contracts/common.ts';
import { strictEmail } from '../../../shared/email.ts';
import { getPointer } from '../../connectors/lib/pointer.ts';
import type { RecordResult, UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getDeps } from './deps.ts';
import { applyMapping } from './mapping.ts';
import type { ConnectionRow } from './repo.ts';
import { getPassByRef, markPassSyncError, markPassSynced } from './repo-passes.ts';

export type Outcome = 'changed' | 'unchanged' | 'created' | 'missing' | 'unlinked' | 'invalid';

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

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z_]{1,39}$/.test(code) ? code : 'RECORD_ERROR';
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
  options: { generation: number; cause: 'connection' | 'user_refresh'; intervalMs: number },
): Promise<Outcome> {
  const deps = getDeps();
  const db = sctx.env.DB;
  const now = sctx.clock.now();
  const nextSyncAt = now + options.intervalMs;
  const pass = await getPassByRef(db, conn.orgId, conn.id, ref);

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
    await deps.markPassMissing(sctx, pass.id, conn.onMissing);
    return 'missing';
  }

  const fields = applyMapping(conn.mapping, incoming.record);
  const holderEmail = holderEmailOf(conn, incoming);
  const fail = async (code: string): Promise<Outcome> => {
    if (pass) {
      await markPassSyncError(db, { passId: pass.id, connectionId: conn.id, code, nextSyncAt });
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
    return fail(errorCode(error));
  }
}
