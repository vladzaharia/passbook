import type { UpstreamRecord } from '../../connectors/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { markIncomingSynced, markIncomingVoided } from './record-outcomes.ts';
import type { Applied, ApplyIncomingOptions } from './records.ts';
import type { ConnectionRow } from './repo.ts';
import type { SyncSnapshot } from './repo-pass-snapshot.ts';
import { hasBinding, type SyncPass } from './repo-passes.ts';
import { advanceRefVersion } from './repo-ref-versions.ts';
import { matchesVoidWhen } from './void-when.ts';

/**
 * Decisions on a present record before it is mapped, in this order: no pass and not allowed to
 * create (or the record only voids) -> unlinked; an older record than the last applied for the ref
 * -> skipped (RECORD_STALE); a void rule matches -> void the pass. Null: apply it as usual.
 * A void with no pass records its version as a tombstone, so an older create that arrives later is
 * stale and cannot issue a pass for a cancelled or refunded source. An update-only record with no
 * pass records nothing: an update delivered before its create must not block that create.
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
  if (!snapshot && options.createAllowed === false && !voids) return { outcome: 'unlinked' };
  if (options.sourceVersion !== undefined) {
    const order = await advanceRefVersion(
      sctx,
      { orgId: conn.orgId },
      conn.id,
      options.generation,
      ref,
      options.sourceVersion,
      options.sourceEvent ?? '',
    );
    if (order === 'fenced') return { outcome: 'fenced', effectFree: true };
    if (order === 'stale') {
      sctx.log.info('connection.record_stale', { connectionId: conn.id, code: 'RECORD_STALE' });
      return snapshot
        ? markIncomingSynced(sctx, snapshot, pass, now, nextSyncAt)
        : { outcome: 'unchanged' };
    }
  }
  if (!snapshot && (options.createAllowed === false || voids)) return { outcome: 'unlinked' };
  return voids ? markIncomingVoided(sctx, conn, snapshot, pass, !!options.retainedBinding) : null;
}

/**
 * A webhook record for a ref with no active pass that cannot open one (it only voids, or it is
 * update-only) never reaches applyIncoming: its claim is a no-effect item. This is the one place it
 * leaves a trace. A void records its version as a tombstone, so an older create that arrives later is
 * stale. A record that no longer matches the void rules of a ref whose pass is voided is logged
 * (the pass stays voided). Returns true when the connection changed (the item is stale).
 */
export async function noteUnboundRecord(
  sctx: ServiceContext,
  conn: ConnectionRow,
  change: { ref: string; record?: UpstreamRecord | undefined; version?: number; event?: string },
): Promise<boolean> {
  const { ref, record, version } = change;
  if (!record || version === undefined) return false;
  if (matchesVoidWhen(conn.voidWhen, record)) {
    const order = await advanceRefVersion(
      sctx,
      { orgId: conn.orgId },
      conn.id,
      conn.generation,
      ref,
      version,
      change.event ?? '',
    );
    return order === 'fenced';
  }
  if (conn.voidWhen.length > 0 && (await hasBinding(sctx.env.DB, conn.orgId, conn.id, ref))) {
    sctx.log.info('connection.void_would_clear', {
      connectionId: conn.id,
      code: 'VOID_WOULD_CLEAR',
    });
  }
  return false;
}
