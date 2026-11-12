import type { Job } from './types.ts';

/** D1 allows 1,000 queries per invocation (a batch counts as one); keep a margin for the rest. */
export const QUEUE_QUERY_BUDGET = 800;

/** Upper-bound queries for one record applied from a connection (lookup, publish, outbox). */
const QUERIES_PER_RECORD = 25;

/**
 * Estimated D1 queries one job spends. A queue invocation runs a whole batch, so the consumer
 * adds these up and defers the rest of the batch once the budget is gone.
 */
export function estimateQueries(job: Job): number {
  switch (job.kind) {
    case 'connection.webhook':
      // Durable item claims/finalization plus legacy binding and release proof reads.
      return 40 + (QUERIES_PER_RECORD + 8) * job.refs.length;
    case 'pass.refresh':
      return 40;
    default:
      return 15;
  }
}
