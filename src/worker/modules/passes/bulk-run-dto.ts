import type { BulkRunDto } from '../../../shared/contracts/pass-bulk-runs.ts';
import type { BulkRunRecord } from './repo-bulk-runs.ts';

/** The run as the API shows it: no starter, no cursor. */
export function bulkRunDto(rec: BulkRunRecord, stopRequested: boolean): BulkRunDto {
  return {
    id: rec.id,
    orgId: rec.orgId,
    action: rec.action,
    state: rec.state,
    total: rec.total,
    done: rec.done,
    skipped: rec.skipped,
    skippedBy: rec.skippedBy,
    stopRequested,
    createdAt: rec.createdAt,
    finishedAt: rec.finishedAt,
    code: rec.code,
  };
}
