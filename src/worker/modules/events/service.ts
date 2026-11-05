import type { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import {
  EVENT_GROUPS,
  type EventActorType,
  type EventKind,
  type PassEventListQuerySchema,
  type PassEventListSchema,
} from '../../../shared/contracts/events.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getPass } from '../passes/repo.ts';
import type { ScopeArg } from '../passes/scope.ts';
import { type EventRow, listEvents } from './repo.ts';

type EventPage = z.infer<typeof PassEventListSchema>;

const encodeCursor = (row: EventRow) => `${row.at}.${row.id}`;

function decodeCursor(cursor: string | undefined): { at: number; id: string } | undefined {
  if (!cursor) return undefined;
  const match = /^(\d{1,15})\.([\w-]{1,64})$/.exec(cursor);
  if (!match?.[1] || !match[2]) throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
  return { at: Number(match[1]), id: match[2] };
}

export function toEventDto(row: EventRow): EventPage['items'][number] {
  return {
    id: row.id,
    passId: row.pass_id,
    mode: row.mode,
    kind: row.kind,
    device: row.device,
    actorType: row.actor_type as EventActorType | null,
    actorId: row.actor_id,
    data: JSON.parse(row.data) as Record<string, Json>,
    at: row.at,
  };
}

/**
 * Events of one pass, newest first. `orgScope` null = platform-wide; a pass outside the scope (org, or
 * an API key's mode) reads as missing. Works in either mode: the caller sees the mode on each event.
 */
export async function listPassEvents(
  ctx: ServiceContext,
  passId: string,
  orgScope: ScopeArg,
  query: z.infer<typeof PassEventListQuerySchema>,
): Promise<EventPage> {
  if (!(await getPass(ctx.env.DB, passId, orgScope)))
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const after = decodeCursor(query.cursor);
  const kinds: EventKind[] = [
    ...new Set([...(query.kind ?? []), ...(query.group ? EVENT_GROUPS[query.group] : [])]),
  ];
  const rows = await listEvents(ctx.env.DB, {
    passId,
    ...(kinds.length ? { kinds } : {}),
    ...(after ? { after } : {}),
    limit: query.limit + 1,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map(toEventDto),
    nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
  };
}
