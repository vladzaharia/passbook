import { IdSchema, type Mode } from '../../../shared/contracts/common.ts';
import { stmt } from '../../platform/db.ts';
import {
  EVENT_SCOPE_TEMPLATES_SQL,
  EVENT_SQL,
  type EventScope,
  eventScopeOf,
  type Raw,
  type ScopedTemplate,
} from './repo-scope.ts';

/** Several events' scopes in one D1 round trip; null when any one is unusable. */
export async function readValidEventScopes(
  db: D1Database,
  orgId: string,
  mode: Mode,
  eventIds: readonly string[],
): Promise<EventScope[] | null> {
  if (eventIds.some((id) => !IdSchema.safeParse(id).success)) return null;
  if (eventIds.length === 0) return [];
  const results = await db.batch(
    eventIds.flatMap((id) => [
      stmt(db, EVENT_SQL, [id, orgId]),
      stmt(db, EVENT_SCOPE_TEMPLATES_SQL, [orgId, mode, id]),
    ]),
  );
  const scopes: EventScope[] = [];
  for (const [i, id] of eventIds.entries()) {
    const raw = results[2 * i]?.results?.[0] as Raw | undefined;
    const scope = eventScopeOf(mode, raw, (results[2 * i + 1]?.results ?? []) as ScopedTemplate[]);
    if (!scope || scope.event.id !== id) return null;
    scopes.push(scope);
  }
  return scopes;
}
