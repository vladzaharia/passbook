import type { ServiceContext } from '../../platform/service-context.ts';
import { closeEndedSpans } from './repo-spans.ts';

const BATCH = 500;
const MAX_BATCHES = 10;

/** Daily hook `usage.close_spans`: tidies expired and idle spans. The gauge never relies on it (AD4). */
export async function dailyCloseSpans(ctx: ServiceContext): Promise<void> {
  let closed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await closeEndedSpans(ctx.env.DB, ctx.clock.now(), BATCH);
    closed += n;
    if (n < BATCH) break;
  }
  if (closed > 0) ctx.log.info('usage.spans_closed', { closed });
}
