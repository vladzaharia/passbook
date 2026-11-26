import type { z } from 'zod';
import type {
  WorkbenchSummary,
  WorkbenchSummaryQuerySchema,
} from '../../../shared/contracts/workbench-read.ts';
import type { AuthContext } from '../../platform/auth.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../developer/home.ts';
import { homeSandboxOf } from '../developer/repo-home.ts';
import { LOG_META_MS } from '../developer/repo-request-log.ts';
import { countFailedDeliveries } from '../webhooks/repo-event-deliveries.ts';
import { contextOrg } from './context.ts';
import { quotasOf } from './quotas.ts';
import {
  emailsSince,
  errorsSince,
  hasActiveTestEndpoint,
  keysExpiringBetween,
} from './repo-summary.ts';

type Query = z.infer<typeof WorkbenchSummaryQuerySchema>;

const DAY = 86_400_000;
const SHOWN_MAX = 99;
const QUICKSTART_TOTAL = 5;

/**
 * The nav's attention state for one context. A count is rows newer than the client's seen mark (`since`), so a
 * failed load that sends no mark never hides anything; each is capped where the nav stops counting.
 */
export async function workbenchSummary(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  q: Query,
): Promise<WorkbenchSummary> {
  const orgId = await contextOrg(ctx, auth, q.orgId);
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const sandbox = auth?.kind === 'session' ? await homeSandboxOf(db, auth.userId) : null;
  const isSandbox = sandbox?.org_id === orgId;
  const [errors, failed, inbox, keysExpiring, listening, quotas] = await Promise.all([
    errorsSince(db, orgId, q['since[logs]'] ?? 0, now - LOG_META_MS),
    countFailedDeliveries(db, orgId, q['since[events]'] ?? 0),
    emailsSince(db, orgId, q['since[inbox]'] ?? 0),
    keysExpiringBetween(db, orgId, now, now + 7 * DAY),
    hasActiveTestEndpoint(db, orgId),
    isSandbox ? quotasOf(ctx, orgId) : null,
  ]);
  const p = isSandbox && sandbox ? progressOf(sandbox) : null;
  return {
    now,
    quickstart: p
      ? {
          // Sign-in and the sandbox are done by the time there is one; then the track's three steps.
          done: 2 + [p.passAt, p.changeAt, p.webhookAt].filter((at) => at !== null).length,
          total: QUICKSTART_TOTAL,
        }
      : null,
    errors: Math.min(errors, SHOWN_MAX),
    failedDeliveries: Math.min(failed, SHOWN_MAX),
    listening,
    inboxNew: Math.min(inbox, SHOWN_MAX),
    keysExpiring,
    quotas,
  };
}
