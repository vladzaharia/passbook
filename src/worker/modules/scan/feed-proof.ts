import type { ServiceContext } from '../../platform/service-context.ts';
import type { ScanLogRow } from './repo-feed.ts';
import { readPasslessScans } from './repo-scan-passless.ts';
import { type ScanEventProofCache, verifyScanEventProvenance } from './scan-event-proof.ts';
import type { PasslessScan } from './scan-passless.ts';

const PROOF_BATCH = 32;

/** The cache is private to a single list/detail/export request. */
export interface FeedProofCache {
  events: ScanEventProofCache;
  credentialKeysetCommitment: string;
}

export function createFeedProofCache(credentialKeysetCommitment: string): FeedProofCache {
  return { events: new Map(), credentialKeysetCommitment };
}

/** Check each row against its own recorded facts; passless scans come from the `scans` row. */
export async function verifyRows(
  ctx: ServiceContext,
  rows: readonly ScanLogRow[],
  cache: FeedProofCache,
): Promise<{ rows: ScanLogRow[]; passless: Map<string, PasslessScan> }> {
  const indexed = rows.filter((row) => row.passlessProofCandidate);
  const first = indexed[0];
  const passless = first
    ? await readPasslessScans(
        ctx.env.DB,
        { mode: first.mode },
        indexed.map((row) => row.id),
      )
    : new Map<string, PasslessScan>();
  const verified = rows.map((row) => ({ ...row, policyAvailable: false }));
  for (let start = 0; start < rows.length; start += PROOF_BATCH) {
    await Promise.all(
      rows.slice(start, start + PROOF_BATCH).map(async (row, index) => {
        const found = passless.get(row.id);
        if (found) {
          if (found.orgId === row.orgId && found.at === row.at && row.source.state === 'done')
            verified[start + index] = { ...row, policyAvailable: true };
          else passless.delete(row.id);
          return;
        }
        if (
          row.passId !== null &&
          row.eventProof &&
          (await verifyScanEventProvenance(
            ctx.env,
            row.eventProof.event,
            row.eventProof.scan,
            cache.events,
          ))
        )
          verified[start + index] = { ...row, policyAvailable: true };
      }),
    );
  }
  return { rows: verified, passless };
}
