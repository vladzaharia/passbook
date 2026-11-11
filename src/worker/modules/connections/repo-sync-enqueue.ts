import { classifyD1Error, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  type ConnectionActor,
  commitOrNull,
  connectionGrant,
  connectionIs,
  plainWrite,
} from './repo-grants.ts';
import { validCredentialKeysetCommitment } from './repo-passes.ts';

/**
 * Insert both tracking rows and commit the enqueue decision in one grant batch: the connection's
 * generation, enabled state, org and the caller's authority are checked in the same transaction as
 * both inserts. A tracking row that already exists is a retry and is kept. A later request may adopt
 * the pair, so it must not be removed on launch failure.
 */
export async function commitSyncEnqueue(
  ctx: ServiceContext,
  expected: {
    instanceId: string;
    orgId: string;
    connectionId: string;
    generation: number;
    credentialKeysetCommitment: string;
    trigger: 'schedule' | 'webhook' | 'admin';
    actorId: string | null;
    startedAt: number;
  },
  actor: ConnectionActor,
): Promise<boolean> {
  if (!validCredentialKeysetCommitment(expected.credentialKeysetCommitment)) return false;
  if (expected.orgId !== actor.orgId) return false;
  const db = ctx.env.DB;
  const enqueue = async (withRun: boolean): Promise<void> => {
    const g = connectionGrant(
      ctx,
      actor,
      'run.enqueue',
      [connectionIs({ id: expected.connectionId, generation: expected.generation, enabled: true })],
      expected.instanceId,
    );
    plainWrite(
      g,
      `INSERT OR IGNORE INTO workflow_runs
         (instance_id, kind, org_id, target_id, status, started_at, credential_keyset_commitment)
       SELECT ?, 'connection_sync', {org}, ?, 'queued', ?, ? WHERE {grant}`,
      [
        expected.instanceId,
        expected.connectionId,
        expected.startedAt,
        expected.credentialKeysetCommitment,
      ],
    );
    if (withRun)
      g.insertJoined('connection_runs', {
        parents: { connection_id: expected.connectionId },
        columns: ['id', 'trigger', 'actor_id', 'started_at', 'outcome'],
        values: [
          expected.instanceId,
          expected.trigger,
          expected.actorId,
          expected.startedAt,
          'running',
        ],
      });
    await commitOrNull(g, actor);
  };
  const exists =
    (await first(db, 'SELECT 1 FROM connection_runs WHERE id = ?', [expected.instanceId])) !== null;
  try {
    await enqueue(!exists);
  } catch (error) {
    // A concurrent request inserted the same run first: keep its row and fill any gap.
    if (exists || classifyD1Error(error)?.kind !== 'unique') throw error;
    await enqueue(false);
  }
  // A refusal above leaves the proof to decide: an existing pair is a retry and must still match.
  const proof = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM workflow_runs w JOIN connection_runs r ON r.id = w.instance_id
       AND r.connection_id = w.target_id AND r.trigger = ?
     JOIN orgs wo ON wo.id = w.org_id
     WHERE w.instance_id = ? AND w.kind = 'connection_sync' AND wo.id = ? AND w.target_id = ?
       AND w.credential_keyset_commitment = ?
       AND EXISTS (SELECT 1 FROM connections c WHERE c.id = w.target_id AND c.org_id = w.org_id
         AND c.enabled = 1 AND c.generation = ?
         AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = c.org_id AND o.status = 'active'))`,
    [
      expected.trigger,
      expected.instanceId,
      expected.orgId,
      expected.connectionId,
      expected.credentialKeysetCommitment,
      expected.generation,
    ],
  );
  return proof !== null;
}
