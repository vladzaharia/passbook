import type { ArrivalDto } from '../../../shared/contracts/index.ts';
import { ConnectorError } from '../../connectors/types.ts';
import { RECIPES } from '../../connectors/webhook-push/recipes/index.ts';
import { classifyD1Error } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { toDto } from './dto.ts';
import type { ConnectionRow } from './repo.ts';
import {
  type ArrivalOutcome,
  type ContentClass,
  firstVerifiedArrivalAt,
  listArrivals,
  writeArrival,
} from './repo-webhook-arrivals.ts';

const MINUTE_MS = 60_000;

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
    const topic = input.outcome === 'rejected' ? null : topicOf(conn, req);
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
          : `${input.outcome}:${reason ?? ''}:${topic ?? ''}:${Math.floor(now / MINUTE_MS)}`,
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
  connectionId: string,
  query: { since: number; limit: number },
): Promise<ArrivalDto[]> {
  return listArrivals(sctx.env.DB, connectionId, query.since, query.limit);
}

/** The connection as the API shows it, with whether a verified delivery has arrived. */
export async function dtoOf(sctx: ServiceContext, row: ConnectionRow) {
  return toDto(sctx.env, row, await firstVerifiedArrivalAt(sctx.env.DB, row.id));
}
