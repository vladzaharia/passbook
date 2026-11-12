import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';
import type { OutputPredicate } from './repo-output-predicates.ts';

export type CandidateMatchInput =
  | { passId: string }
  | { scanCode: string | null; barcodeHash: string; lookupHash: string; serial: string | null };

/** Match the same credential alternatives used by candidate reads, in their original bind order. */
export function candidateMatchPredicate(input: CandidateMatchInput): OutputPredicate {
  const matches: string[] = [];
  const params: SqlValue[] = [];
  if ('passId' in input) {
    matches.push('p.id=?/* scan-ephemeral-pass-id */');
    params.push(input.passId);
  } else {
    if (input.scanCode) {
      matches.push('p.scan_code=?/* scan-ephemeral-scan-code */');
      params.push(input.scanCode);
    }
    matches.push(
      'p.barcode_hash=?/* scan-ephemeral-barcode-hash */',
      'p.lookup_hash=?/* scan-ephemeral-lookup-hash */',
    );
    params.push(input.barcodeHash, input.lookupHash);
    if (input.serial !== null) {
      matches.push('p.serial=?/* scan-ephemeral-serial */');
      params.push(input.serial);
    }
  }
  return { sql: matches.join(' OR '), params };
}

/** Conservative same-mode scan counts for the candidate alternatives. */
export function candidateCapacityStmt(
  db: D1Database,
  actor: Pick<ScanActor, 'orgId' | 'mode'>,
  input: CandidateMatchInput | null,
): D1PreparedStatement | null {
  if (!input) return null;
  const matches = candidateMatchPredicate(input);
  return stmt(
    db,
    `SELECT p.id, COUNT(s.id) AS n
    FROM passes p LEFT JOIN scans s ON s.org_id=p.org_id AND s.mode=p.mode AND s.pass_id=p.id
    WHERE p.org_id=? AND p.mode=? AND (${matches.sql}) GROUP BY p.id`,
    [actor.orgId, actor.mode, ...matches.params],
  );
}

export function candidateReadGuard(
  authority: OutputPredicate,
  csrf: OutputPredicate,
): OutputPredicate {
  return {
    sql: `(${authority.sql}) AND (${csrf.sql})`,
    params: [...authority.params, ...csrf.params],
  };
}
