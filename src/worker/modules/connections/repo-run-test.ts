import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  rowCount,
} from './repo-grants.ts';

/**
 * A configuration test leaves one finished run, written once after the connector call. There is no
 * `running` row to clean up if the caller loses access meanwhile; the final write refuses instead.
 */
export async function recordTestRun(
  ctx: ServiceContext,
  r: {
    id: string;
    connectionId: string;
    generation: number;
    actorId: string | null;
    startedAt: number;
    finishedAt: number;
    outcome: 'unchanged' | 'error';
    errorCode: string | null;
    httpStatus: number | null;
  },
  actor: ConnectionActor,
): Promise<boolean> {
  const g = connectionGrant(
    ctx,
    actor,
    'run.test',
    [connectionIs({ id: r.connectionId, generation: r.generation })],
    r.id,
  );
  g.insertJoined('connection_runs', {
    parents: { connection_id: r.connectionId },
    columns: [
      'id',
      'trigger',
      'actor_id',
      'started_at',
      'finished_at',
      'outcome',
      'records_seen',
      'passes_changed',
      'error_code',
      'http_status',
      'duration_ms',
    ],
    values: [
      r.id,
      'test',
      r.actorId,
      r.startedAt,
      r.finishedAt,
      r.outcome,
      0,
      0,
      r.errorCode,
      r.httpStatus,
      r.finishedAt - r.startedAt,
    ],
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
