import type { Check } from '../../platform/authority-checks.ts';
import { ConflictError } from '../../platform/errors.ts';

/**
 * What a bulk run adds to a pass write: proofs that commit with the write (the starter), the version
 * the run's snapshot saw (re-checked on every compare-and-swap attempt), and the run's id for the audit.
 * Pushes are dispatched once per chunk, not per pass.
 */
export interface RunWrite {
  checks: readonly Check[];
  version: number;
  runId: string;
}

/** A status change that refuses (PASS_CHANGED) when the pass is not at the run's snapshot version. */
export const pinnedStatus =
  <S extends string>(run: RunWrite | undefined, status: S) =>
  (current: { version: number }) => {
    if (run && current.version !== run.version)
      throw new ConflictError('The pass changed since the run started.', 'PASS_CHANGED');
    return { status };
  };
