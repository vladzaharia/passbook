import type { Mode } from '../../../shared/contracts/common.ts';
import type { BulkPrintStatus } from '../../../shared/contracts/prints.ts';
import { bulkKey } from './pdf-store.ts';

/** A pending job older than this has lost its message (the queue gave up): report it failed. */
const PENDING_LIMIT_MS = 30 * 60_000;
/** A bulk PDF and its status are served for this long, then gone (the sweep deletes them too). */
export const BULK_TTL_MS = 24 * 3_600_000;

/** What R2 holds for a job: the public status plus who asked and which passes it holds. */
export interface StoredBulkStatus extends BulkPrintStatus {
  at: number;
  userId: string;
  mode: Mode;
  passIds: string[];
}

/** The caller's view of a job; null when it is missing, expired or not theirs (user, org, mode). */
export async function readBulkStatus(
  bucket: R2Bucket,
  who: { orgId: string; userId: string; mode: Mode },
  jobId: string,
  now: number,
): Promise<BulkPrintStatus | null> {
  const object = await bucket.get(bulkKey(who.orgId, jobId, 'json'));
  if (!object) return null;
  const s = (await object.json()) as StoredBulkStatus;
  if (s.userId !== who.userId || s.mode !== who.mode || now - s.at > BULK_TTL_MS) return null;
  const lost = s.state === 'pending' && now - s.at > PENDING_LIMIT_MS;
  const { state, count, skipped, engine, lossy } = s;
  return { state: lost ? 'failed' : state, count, skipped, lossy, ...(engine ? { engine } : {}) };
}

/** The stored record, for the job that owns it. */
export async function readStoredBulk(
  bucket: R2Bucket,
  orgId: string,
  jobId: string,
): Promise<StoredBulkStatus | null> {
  const object = await bucket.get(bulkKey(orgId, jobId, 'json'));
  return object ? ((await object.json()) as StoredBulkStatus) : null;
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
