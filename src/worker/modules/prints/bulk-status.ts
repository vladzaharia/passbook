import type { BulkPrintStatus } from '../../../shared/contracts/prints.ts';
import { bulkKey } from './pdf-store.ts';

/** A pending job older than this has lost its message (the queue gave up): report it failed. */
const PENDING_LIMIT_MS = 30 * 60_000;

export interface StoredBulkStatus extends BulkPrintStatus {
  at: number;
}

export async function readBulkStatus(
  bucket: R2Bucket,
  orgId: string,
  jobId: string,
  now: number,
): Promise<BulkPrintStatus | null> {
  const object = await bucket.get(bulkKey(orgId, jobId, 'json'));
  if (!object) return null;
  const s = (await object.json()) as StoredBulkStatus;
  const lost = s.state === 'pending' && now - s.at > PENDING_LIMIT_MS;
  return { state: lost ? 'failed' : s.state, count: s.count };
}

export async function writeBulkStatus(
  bucket: R2Bucket,
  orgId: string,
  jobId: string,
  status: StoredBulkStatus,
): Promise<void> {
  await bucket.put(bulkKey(orgId, jobId, 'json'), JSON.stringify(status), {
    httpMetadata: { contentType: 'application/json' },
  });
}
