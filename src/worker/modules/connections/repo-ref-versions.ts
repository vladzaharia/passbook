import { jobGrant } from '../../platform/authority.ts';
import { lt, lte } from '../../platform/authority-expr.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  rowCount,
} from './repo-grants.ts';

/**
 * Records `version` as the newest applied for the ref, unless a newer one is already stored. Records of
 * the same version are ordered by event id (the larger wins; the same event applies again, so a retry
 * works). `stale`: a newer record is stored. `fenced`: the connection changed.
 */
export async function advanceRefVersion(
  ctx: ServiceContext,
  actor: ConnectionActor,
  connectionId: string,
  generation: number,
  ref: string,
  version: number,
  eventId: string,
): Promise<'applied' | 'stale' | 'fenced'> {
  const stored = await first<{ source_version: number; source_event: string }>(
    ctx.env.DB,
    'SELECT source_version, source_event FROM connection_ref_versions WHERE connection_id = ? AND ref = ?',
    [connectionId, ref],
  );
  if (stored && stored.source_version === version && stored.source_event > eventId) return 'stale';
  const g = connectionGrant(
    ctx,
    actor,
    'ref_version',
    [connectionIs({ id: connectionId, generation })],
    connectionId,
  );
  g.upsert(
    'connection_ref_versions',
    ['connection_id', 'ref', 'source_version', 'source_event', 'updated_at'],
    [connectionId, ref, version, eventId, ctx.clock.now()],
    {
      update: ['source_version', 'source_event', 'updated_at'],
      where: { source_version: lte(version) },
      returning: ['ref'],
    },
  );
  const results = await commitOrNull(g, actor);
  if (results === null) return 'fenced';
  return rowCount(results.at(-1)) === 1 ? 'applied' : 'stale';
}

/** Drops source versions of refs not written for a while, under a platform job grant. */
export async function deleteIdleRefVersions(ctx: ServiceContext, before: number): Promise<number> {
  const g = jobGrant(ctx, {
    purpose: 'platform.job.connections_retention',
    job: 'connection-retention',
  });
  g.delete('connection_ref_versions', { where: { updated_at: lt(before) }, returning: ['ref'] });
  return (await g.commit())[0]?.results.length ?? 0;
}
