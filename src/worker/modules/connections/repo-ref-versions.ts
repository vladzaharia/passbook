import { lte } from '../../platform/authority-expr.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  rowCount,
} from './repo-grants.ts';

/**
 * Records `version` as the newest applied for the ref, unless a newer one is already stored.
 * Equal versions apply (a retried delivery re-applies). `stale`: a newer version is stored. `fenced`: the connection changed.
 */
export async function advanceRefVersion(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  generation: number,
  ref: string,
  version: number,
): Promise<'applied' | 'stale' | 'fenced'> {
  const g = connectionGrant(
    ctx,
    actor,
    'ref_version',
    [connectionIs({ id: connectionId, generation })],
    connectionId,
  );
  g.upsert(
    'connection_ref_versions',
    ['connection_id', 'ref', 'source_version', 'updated_at'],
    [connectionId, ref, version, ctx.clock.now()],
    {
      update: ['source_version', 'updated_at'],
      where: { source_version: lte(version) },
      returning: ['ref'],
    },
  );
  const results = await commitOrNull(g, actor);
  if (results === null) return 'fenced';
  return rowCount(results.at(-1)) === 1 ? 'applied' : 'stale';
}
