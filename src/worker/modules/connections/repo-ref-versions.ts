import { jobGrant } from '../../platform/authority.ts';
import { lt, lte } from '../../platform/authority-expr.ts';
import { all, first } from '../../platform/db.ts';
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

const KEYS_PER_SELECT = 200;
const DELETES_PER_GRANT = 50;
/** Most rows dropped in one run; the rest wait for the next. */
const MAX_DELETES_PER_RUN = 5000;

/**
 * Drops source versions of refs not written since `before`, a bounded batch at a time under a platform
 * job grant. Each row is deleted by its key, re-asserting its age, so a row written meanwhile stays.
 */
export async function deleteIdleRefVersions(ctx: ServiceContext, before: number): Promise<number> {
  let total = 0;
  while (total < MAX_DELETES_PER_RUN) {
    const keys = await all<{ connection_id: string; ref: string }>(
      ctx.env.DB,
      'SELECT connection_id, ref FROM connection_ref_versions WHERE updated_at < ? LIMIT ?',
      [before, KEYS_PER_SELECT],
    );
    let deleted = 0;
    for (let i = 0; i < keys.length; i += DELETES_PER_GRANT) {
      const g = jobGrant(ctx, {
        purpose: 'platform.job.connections_retention',
        job: 'connection-retention',
      });
      for (const k of keys.slice(i, i + DELETES_PER_GRANT)) {
        g.delete('connection_ref_versions', {
          where: { connection_id: k.connection_id, ref: k.ref, updated_at: lt(before) },
          returning: ['ref'],
        });
      }
      deleted += (await g.commit()).reduce((n, r) => n + r.results.length, 0);
    }
    total += deleted;
    if (keys.length < KEYS_PER_SELECT || deleted === 0) break;
  }
  return total;
}
