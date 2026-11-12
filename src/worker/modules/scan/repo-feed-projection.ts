import type { SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';
import type { ScanActor } from './actor.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import {
  type ScanLogFilter,
  type ScanLogRow,
  scanLedgerBoundaryPredicate,
  scanLogSnapshotPredicate,
} from './repo-feed.ts';
import {
  type HistoryProofFence,
  historyProofSnapshotPredicates,
} from './repo-history-proof-cas.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';
import { scanPasslessSnapshotPredicate } from './repo-scan-passless.ts';
import type { PasslessScan } from './scan-passless.ts';

type FeedBoundary = { row: ScanLogRow; filter: ScanLogFilter; now: number };
type FeedSnapshot = {
  actor: ScanActor;
  row: ScanLogRow;
  proof: HistoryProofFence | null;
  passless: PasslessScan | null;
};

/** Keep the session secret in direct scalar binds alongside the actor authority. */
export function consoleFeedAuthoritySql(
  ctx: ServiceContext,
  actor: ScanActor,
  csrf: OutputPredicate | null,
): { sql: string; params: SqlValue[] } {
  if (!csrf) return { sql: '0', params: [] };
  const current = actorAuthorityPredicate({
    actor,
    event: null,
    now: ctx.clock.now(),
    adminEventTemplates: false,
  });
  return { sql: `(${current.sql}) AND (${csrf.sql})`, params: [...current.params, ...csrf.params] };
}

export function consoleFeedBoundaryPredicate(boundary?: FeedBoundary): OutputPredicate {
  return boundary
    ? scanLedgerBoundaryPredicate(boundary.row, boundary.filter, boundary.now)
    : { sql: '1', params: [] };
}

/** Rebind each selected ledger row and all of its proof fragments to the viewer and keyset. */
export function consoleFeedRecordPredicates(
  items: readonly { snapshot: FeedSnapshot }[],
  now: number,
  credentialKeysetCommitment: string,
): OutputPredicate[][] {
  return items.map(({ snapshot: { actor, row, proof, passless } }) => {
    const authority = actorAuthorityPredicate({
      actor,
      event: null,
      now,
      templateId: proof ? (row.templateId ?? undefined) : undefined,
      adminEventTemplates: actor.adminEventTemplates === true,
    });
    const scan = scanLogSnapshotPredicate(row, now);
    const bindings = proof
      ? historyProofSnapshotPredicates(proof, 's', now)
      : passless
        ? [scanPasslessSnapshotPredicate('s', passless)]
        : [];
    if (proof && !bindings.length) bindings.push({ sql: '0', params: [] });
    return [
      {
        sql: `(${authority.sql}) AND (${scan.sql}) AND ${credentialRefKeysetSql}`,
        params: [...authority.params, ...scan.params, credentialKeysetCommitment],
      },
      ...bindings.map((binding) => ({
        sql: `EXISTS (SELECT 1 FROM scans s WHERE s.id = ?/* scan-ephemeral-scan-id */
            AND (${binding.sql})) AND ${credentialRefKeysetSql}`,
        params: [row.id, ...binding.params, credentialKeysetCommitment],
      })),
    ];
  });
}

/** Preserve request authority, keyset, boundary and row checks in their transaction order. */
export function consoleFeedFencePredicates(
  requestAuthority: OutputPredicate,
  credentialKeysetCommitment: string,
  boundaryCheck: OutputPredicate,
  predicates: readonly OutputPredicate[][],
): OutputPredicate[] {
  return [
    requestAuthority,
    { sql: credentialRefKeysetSql, params: [credentialKeysetCommitment] },
    {
      sql: `(${boundaryCheck.sql}) AND ${credentialRefKeysetSql}`,
      params: [...boundaryCheck.params, credentialKeysetCommitment],
    },
    ...predicates.flat(),
  ];
}
