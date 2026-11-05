import type { ServiceContext } from '../../platform/service-context.ts';

/** Minute: closes abandoned scan rows and applies queued pushes (stream SV fills it in). */
export async function reconcileScans(_ctx: ServiceContext): Promise<void> {}

/** Minute: back-fills passes.lookup_hash in bounded batches (stream SV fills it in). */
export async function backfillScanLookups(_ctx: ServiceContext): Promise<void> {}

/** Daily: scan retention (`retention.scansDays`), gates and counters (stream SV fills it in). */
export async function dailyScans(_ctx: ServiceContext): Promise<void> {}
