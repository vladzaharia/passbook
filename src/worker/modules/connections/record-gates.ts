import type { UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { markIncomingSynced, markIncomingVoided } from './record-outcomes.ts';
import type { Applied, ApplyIncomingOptions } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import type { SyncSnapshot } from './repo-pass-snapshot.ts';
import type { SyncPass } from './repo-passes.ts';
import { advanceRefVersion } from './repo-ref-versions.ts';
import { matchesVoidWhen } from './void-when.ts';

/**
 * Decisions on a present record before it is mapped, in this order: no pass and not allowed to
 * create (or the record only voids) -> unlinked; an older record than the last applied for the ref
 * -> skipped (RECORD_STALE); a void rule matches -> void the pass. Null: apply it as usual.
 * The version is only recorded for a record that will act, so an update that is skipped for lack of
 * a pass cannot make the later create look stale.
 */
export async function gateRecord(
  sctx: ServiceContext,
  conn: ConnectionRow,
  ref: string,
  record: UpstreamRecord,
  snapshot: SyncSnapshot | null,
  pass: SyncPass | null,
  options: ApplyIncomingOptions,
  now: number,
  nextSyncAt: number,
): Promise<Applied | null> {
  const voids = matchesVoidWhen(conn.voidWhen, record);
  if (!snapshot && (options.createAllowed === false || voids)) return { outcome: 'unlinked' };
  if (options.sourceVersion !== undefined) {
    const order = await advanceRefVersion(
      sctx,
      { orgId: conn.orgId },
      conn.id,
      options.generation,
      ref,
      options.sourceVersion,
    );
    if (order === 'fenced') return { outcome: 'fenced', effectFree: true };
    if (order === 'stale') {
      sctx.log.info('connection.record_stale', { connectionId: conn.id, code: 'RECORD_STALE' });
      return snapshot
        ? markIncomingSynced(sctx, snapshot, pass, now, nextSyncAt)
        : { outcome: 'unchanged' };
    }
  }
  return voids ? markIncomingVoided(sctx, conn, snapshot, pass, !!options.retainedBinding) : null;
}
