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
    case 'webhook.deliver':
      // 15 for the lane and a hand-off, plus 9 per failed attempt (extend, endpoint, due, claim, secrets,
      // limit, batch, disable check), at most 20.
      return 195;
    // CPU, not queries, is the cost (image checks, stamp strips): it runs alone in its invocation,
    // so a CPU kill cannot retry pushes and emails with it.
    case 'template.fork_update':
      return QUEUE_QUERY_BUDGET;
    // A reissue reconciles many copies, each with its own reads: it spends a whole invocation.
    case 'wallet.reissue':
      return QUEUE_QUERY_BUDGET;
    case 'prints.bulk':
      // Per pass: the pass, its channels, org, template and print reads.
      return 10 + 10 * job.passIds.length;
    // A kind's hook may do a whole run's work: it spends an invocation.
    case 'operation.run':
      return QUEUE_QUERY_BUDGET;
    case 'message_rule.check':
      return 14;
    // Measured 7 with an in-memory registry: the row, the outbox check and commit, the dispatch.
    // The D1 registry adds its template reads.
    case 'pass.boundary_refresh':
      return 10;
    default:
      return 15;
  }
}
