import type { ArrivalDto } from '../../../shared/contracts/index.ts';
import { ConnectorError } from '../../connectors/types.ts';
import { RECIPES } from '../../connectors/webhook-push/recipes/index.ts';
import { classifyD1Error } from '../../platform/db.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from './dto.ts';
import type { ConnectionRow } from './repo.ts';
import type { ArrivalSummary } from './repo-webhook-arrivals.ts';
import {
  type ArrivalOutcome,
  arrivalSummaries,
  type ContentClass,
  listArrivals,
  writeArrival,
} from './repo-webhook-arrivals.ts';

const MINUTE_MS = 60_000;
/** A refusal burst in this isolate writes at most one row per connection and reason in this time. */
const DEBOUNCE_MS = 5_000;
const lastRefusalWrite = new Map<string, number>();

export const NO_ARRIVALS: ArrivalSummary = { firstVerifiedAt: null, staleRun: false };

export type ArrivalReason = NonNullable<ArrivalDto['reason']>;

/** The ledger row for a refused delivery. `null`: the failure is not one the ledger records. */
export function rejectReason(error: unknown): ArrivalReason | null {
  if (!(error instanceof ConnectorError)) return null;
  if (error.code === 'AUTH') {
    return error.detail === 'missing'
      ? 'signature_missing'
      : error.detail === 'expired'
        ? 'signature_expired'
        : error.detail === 'no_secret'
          ? 'no_secret'
          : 'signature_mismatch';
  }
  if (error.code === 'INVALID_PAYLOAD')
    return error.detail === 'too_large' ? 'too_large' : 'payload';
  return null;
}

/** A closed class from the media type; the header's own text is never kept. */
export function contentClassOf(req: Request): ContentClass {
  const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'application/json' || type.endsWith('+json')) return 'json';
  if (type.endsWith('/xml') || type.endsWith('+xml')) return 'xml';
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') return 'form';
  return 'other';
}

/**
 * The topic header, kept only when it is one of the recipe's own topics (else `other`). Sender text
 * never reaches the table, so the number of distinct values is bounded by the recipe.
 */
export function topicOf(conn: Pick<ConnectionRow, 'config'>, req: Request): string | null {
  const id = conn.config.recipe;
  const recipe =
    typeof id === 'string' && id !== 'custom' ? RECIPES[id as keyof typeof RECIPES] : null;
  const value = recipe?.topicHeader ? req.headers.get(recipe.topicHeader) : null;
  if (!recipe || value === null) return null;
  return recipe.topics.includes(value) ? value : 'other';
}

/**
 * Refusals come from anyone who knows the URL: the ledger gets its own budget per connection, apart from
 * the per-IP limit. Over budget the row is dropped and the answer is unchanged; `count` is "at least".
 */
async function refusalBudget(
  sctx: ServiceContext,
  connectionId: string,
  reason: string | null,
  now: number,
): Promise<boolean> {
  const key = `${connectionId}:${reason ?? ''}`;
  if (now - (lastRefusalWrite.get(key) ?? -DEBOUNCE_MS) < DEBOUNCE_MS) return false;
  if (!(await checkRateLimit(sctx.env, 'RL_WEBHOOK_LEDGER', connectionId))) return false;
  lastRefusalWrite.set(key, now);
  if (lastRefusalWrite.size > 1_000) {
    const oldest = lastRefusalWrite.keys().next().value;
    if (oldest !== undefined) lastRefusalWrite.delete(oldest);
  }
  return true;
}

export interface ArrivalInput {
  outcome: ArrivalOutcome;
  reason?: ArrivalReason;
  eventId?: string;
  usedPrevious?: boolean;
}

/**
 * Records what the ingress saw, best effort: a failure here is logged with a code and never changes the
 * answer to the sender. Only an accepted event gets a row of its own; the rest coalesce per minute.
 * A refusal keeps no topic: the header is unsigned, and one row per reason bounds what a stranger writes.
 */
export async function recordArrival(
  sctx: ServiceContext,
  conn: ConnectionRow,
  req: Request,
  input: ArrivalInput,
): Promise<void> {
  try {
    const now = sctx.clock.now();
    const reason = input.reason ?? null;
    if (input.outcome === 'rejected' && !(await refusalBudget(sctx, conn.id, reason, now))) return;
    // A refusal or a duplicate rests on an unsigned header: no topic.
    const topic =
      input.outcome === 'rejected' || input.outcome === 'duplicate' ? null : topicOf(conn, req);
    await writeArrival(sctx.env.DB, {
      id: sctx.ids.id(),
      orgId: conn.orgId,
      connectionId: conn.id,
      now,
      outcome: input.outcome,
      reason,
      topic,
      contentClass: contentClassOf(req),
      eventId: input.eventId?.slice(0, 200) ?? null,
      usedPrevious: input.usedPrevious === true,
      coalesceKey:
        input.outcome === 'accepted'
          ? null
          : `${input.outcome}:${reason ?? ''}:${Math.floor(now / MINUTE_MS)}`,
    });
  } catch (error) {
    sctx.log.error('connection.webhook_arrival_failed', {
      connectionId: conn.id,
      code: classifyD1Error(error)?.kind ?? 'INTERNAL',
    });
  }
}

export async function connectionArrivals(
  sctx: ServiceContext,
  orgId: string,
  connectionId: string,
  query: { since: number; limit: number },
): Promise<ArrivalDto[]> {
  return listArrivals(sctx.env.DB, orgId, connectionId, query.since, query.limit);
}

export async function summaryOf(sctx: ServiceContext, id: string): Promise<ArrivalSummary> {
  return (await arrivalSummaries(sctx.env.DB, [id], sctx.clock.now())).get(id) ?? NO_ARRIVALS;
}

/** The connection as the API shows it, with whether a verified delivery has arrived. */
export async function dtoOf(sctx: ServiceContext, row: ConnectionRow) {
  return toDto(sctx.env, row, await summaryOf(sctx, row.id));
}
