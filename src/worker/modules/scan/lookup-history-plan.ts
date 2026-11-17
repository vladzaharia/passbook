import type { Mode } from '../../../shared/contracts/common.ts';
import { chunk } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type HistoryRaw,
  projectionCurrentOf,
  scanReferenceOf,
  toHistoryRow,
} from './history-row.ts';
import { privateValues } from './history-row-evidence.ts';
import { validCredentialKeysetCommitment } from './repo-credential-tombstones.ts';
import { type LookupHistoryProof, lookupHistoryPageStmt } from './repo-lookup-history.ts';
import { verifyScanEventProvenance } from './scan-event-proof.ts';

export interface HistoryOrgScope {
  orgId: string;
  mode: Mode;
  credentialKeysetCommitment: string;
}

type ReadResult = { success: true; results: unknown[] } | { success: false; results?: unknown[] };

const IDS_PER_STATEMENT = 50;

async function proven(ctx: ServiceContext, raw: HistoryRaw): Promise<LookupHistoryProof | null> {
  const row = toHistoryRow(raw);
  const scan = scanReferenceOf(raw);
  if (
    row.passId === null ||
    !row.ledger ||
    !scan ||
    (raw.approved_proof !== 1 && raw.legacy_proof !== 1) ||
    !projectionCurrentOf(raw) ||
    privateValues(raw) === null ||
    typeof raw.current_credential_generation !== 'number' ||
    typeof raw.current_lifecycle_generation !== 'number' ||
    !Number.isSafeInteger(raw.current_lifecycle_generation) ||
    raw.current_lifecycle_generation < 0 ||
    !(await verifyScanEventProvenance(ctx.env, row.ledger, scan))
  )
    return null;
  return Object.freeze({
    scan: Object.freeze({ id: row.id, passId: row.passId, templateId: row.templateId, at: row.at }),
    lineage: Object.freeze({
      orgId: row.orgId,
      mode: row.mode,
      passId: row.passId,
      credentialGeneration: raw.current_credential_generation,
      lifecycleGeneration: raw.current_lifecycle_generation,
    }),
  });
}

/**
 * Prepare the named last scans' history rows for a caller's existing D1 batch. One page statement
 * per fifty scans reads each scan, its signed event and its pass in one snapshot; a page that
 * names anything else proves nothing.
 */
export function planHistoryProofSnapshotsForOrg(
  ctx: ServiceContext,
  scope: HistoryOrgScope,
  scanIds: readonly string[],
): {
  stmts: D1PreparedStatement[];
  finish(results: readonly ReadResult[]): Promise<Map<string, LookupHistoryProof>>;
} {
  const captured = { ...scope };
  const ids = [...new Set(scanIds)];
  const requested = new Set(ids);
  const stmts = validCredentialKeysetCommitment(captured.credentialKeysetCommitment)
    ? chunk(ids, IDS_PER_STATEMENT).map((group) =>
        lookupHistoryPageStmt(ctx.env.DB, captured, group, ctx.clock.now()),
      )
    : [];
  let consumed = false;
  return {
    stmts,
    async finish(results) {
      if (consumed || results.length !== stmts.length) return new Map();
      consumed = true;
      const proofs = new Map<string, LookupHistoryProof>();
      const seen = new Set<string>();
      for (const result of results) {
        if (!result.results || result.success === false) return new Map();
        const rows = result.results as unknown as HistoryRaw[];
        for (const raw of rows)
          if (
            !requested.has(raw.id) ||
            seen.has(raw.id) ||
            raw.org_id !== captured.orgId ||
            raw.mode !== captured.mode
          )
            return new Map();
        for (const raw of rows) seen.add(raw.id);
        const verified = await Promise.all(rows.map((raw) => proven(ctx, raw)));
        rows.forEach((raw, index) => {
          const proof = verified[index];
          if (proof) proofs.set(raw.id, proof);
        });
      }
      return proofs;
    },
  };
}
