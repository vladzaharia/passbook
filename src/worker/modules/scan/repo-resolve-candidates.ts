import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ScanActor } from './guard.ts';

export type CandidateMatchInput =
  | { passId: string }
  | {
      scanCode: string | null;
      barcodeHash: string;
      lookupHash: string;
      serial: string | null;
      /** Keyed ref of a print code, when the input is shaped like one. */
      printRef?: string | null;
    };

/** Match the same credential alternatives used by candidate reads, over a `passes` row aliased `p`. */
export function candidateMatchPredicate(input: CandidateMatchInput): {
  sql: string;
  params: SqlValue[];
} {
  const matches: string[] = [];
  const params: SqlValue[] = [];
  if ('passId' in input) {
    matches.push('p.id=?');
    params.push(input.passId);
  } else {
    if (input.scanCode) {
      matches.push('p.scan_code=?');
      params.push(input.scanCode);
    }
    matches.push('p.barcode_hash=?', 'p.lookup_hash=?');
    params.push(input.barcodeHash, input.lookupHash);
    if (input.serial !== null) {
      matches.push('p.serial=?');
      params.push(input.serial);
    }
    if (input.printRef) {
      matches.push('p.id IN (SELECT pass_id FROM pass_prints WHERE print_code_hash=?)');
      params.push(input.printRef);
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
