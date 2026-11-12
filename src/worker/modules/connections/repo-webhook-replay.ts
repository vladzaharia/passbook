import { exactlyOne, rawCheck, releaseHead } from '../../platform/authority-checks.ts';
import { writePart } from '../../platform/authority-include.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ConnectionAuthority } from './access.ts';
import {
  commitOrNull,
  connectionGrant,
  connectionIs,
  retentionIs,
  rowCount,
} from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

interface ReplayRelease {
  id: string;
  generation: number;
  version: string;
}
interface ReplayReservation {
  releaseSnapshot: string;
  authority: ConnectionAuthority;
  now: number;
  pendingBefore: number;
  replayId: string;
  actorType: 'user' | 'api_key';
  actorId: string;
  oldRelease: ReplayRelease | null;
  oldBlockCode: string | null;
  newRelease: ReplayRelease | null;
  rebind: boolean;
}

/** The authorized reservation, selective item reset, and replay audit commit together. */
export async function reserveReplay(
  ctx: ServiceContext,
  row: RetainedRow,
  p: ReplayReservation,
): Promise<boolean> {
  const proof = row.credentialKeysetCommitment;
  if (!proof || !/^[0-9a-f]{64}$/.test(proof)) return false;
  if (row.connectionMode !== 'webhook' && row.connectionMode !== 'hybrid') return false;
  const db = ctx.env.DB;
  let templateId: string | null = null;
  if (p.newRelease) {
    templateId =
      (
        await first<{ default_template_id: string | null }>(
          db,
          'SELECT default_template_id FROM connections WHERE id = ?',
          [row.connectionId],
        )
      )?.default_template_id ?? null;
    if (!templateId) return false;
  }
  // Items to fail on a rebind are the pending ones staged under another release.
  const stale = p.rebind
    ? await all<{ ordinal: number; release_snapshot: string }>(
        db,
        "SELECT ordinal, release_snapshot FROM connection_webhook_items WHERE retention_id = ? AND state = 'pending' AND release_snapshot <> ?",
        [row.id, p.releaseSnapshot],
      )
    : [];
  const actor = { orgId: row.orgId, authority: p.authority };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.replay',
    [
      connectionIs({
        id: row.connectionId,
        generation: row.generation,
        syncMode: row.connectionMode,
        enabled: true,
      }),
      retentionIs(row.id, {
        connection_id: row.connectionId,
        generation: row.generation,
        connection_mode: row.connectionMode,
        release_snapshot: row.releaseSnapshot,
        snapshot_known: 1,
        updated_at: row.updatedAt,
        revision: row.revision,
        credential_keyset_commitment: proof,
      }),
      rawCheck(
        'retention',
        `EXISTS (SELECT 1 FROM connection_webhook_retention r WHERE r.id = ?
          AND (r.state IN ('failed', 'blocked') OR (r.state = 'pending' AND r.updated_at <= ?)))`,
        [row.id, p.pendingBefore],
      ),
      rawCheck(
        'retention',
        "NOT EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.state = 'started')",
        [row.id],
      ),
      p.rebind
        ? rawCheck(
            'retention',
            "EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.state = 'blocked' AND i.prior_unknown = 0)",
            [row.id],
          )
        : rawCheck(
            'retention',
            `(SELECT item_count FROM connection_webhook_retention WHERE id = ?) = 0
              OR EXISTS (SELECT 1 FROM connection_webhook_items i
                JOIN connection_webhook_retention r ON r.id = i.retention_id
                WHERE i.retention_id = ? AND i.release_snapshot = r.release_snapshot
                  AND (i.state = 'pending' OR (i.state = 'failed' AND i.prior_unknown = 0)))`,
            [row.id, row.id],
          ),
      ...(p.newRelease && templateId
        ? [
            exactlyOne(
              'connections',
              { id: row.connectionId, default_template_id: templateId },
              undefined,
              'config',
            ),
            releaseHead(templateId, 'live', 'apple', p.newRelease.id),
          ]
        : []),
    ],
    row.id,
  );
  g.update('connection_webhook_retention', {
    set: {
      state: 'pending',
      error_code: null,
      release_snapshot: p.releaseSnapshot,
      updated_at: p.now,
      last_replay_id: p.replayId,
    },
    inc: ['revision', 'replay_generation'],
    where: { id: row.id },
    returning: ['id'],
  });
  g.include(
    writePart(
      `INSERT INTO connection_webhook_replays
        (id, retention_id, connection_id, org_id, actor_type, actor_id, replay_generation,
         old_release_id, old_release_generation, old_release_version, old_block_code,
         new_release_id, new_release_generation, new_release_version, created_at)
       SELECT ?, r.id, r.connection_id, {org}, ?, ?, r.replay_generation, ?, ?, ?, ?, ?, ?, ?, ?
       FROM connection_webhook_retention r WHERE r.id = ? AND r.last_replay_id = ? AND {grant}`,
      [
        p.replayId,
        p.actorType,
        p.actorId,
        p.oldRelease?.id ?? null,
        p.oldRelease?.generation ?? null,
        p.oldRelease?.version ?? null,
        p.oldBlockCode,
        p.newRelease?.id ?? null,
        p.newRelease?.generation ?? null,
        p.newRelease?.version ?? null,
        p.now,
        row.id,
        p.replayId,
      ],
    ),
  );
  for (const item of stale)
    g.joined('connection_webhook_items', {
      set: { state: 'failed', error_code: 'WEBHOOK_RELEASE_STALE' },
      where: {
        retention_id: row.id,
        ordinal: item.ordinal,
        state: 'pending',
        release_snapshot: item.release_snapshot,
      },
    });
  g.joined('connection_webhook_items', {
    set: { state: 'pending', token: null, error_code: null, release_snapshot: p.releaseSnapshot },
    where: {
      retention_id: row.id,
      state: p.rebind ? 'blocked' : 'failed',
      prior_unknown: 0,
      ...(p.rebind ? {} : { release_snapshot: p.releaseSnapshot }),
    },
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results[0]) === 1 : false;
}

/** After a failed enqueue the reserved replay returns to `failed` so it can be replayed again. */
export async function restoreFailedReplay(
  ctx: ServiceContext,
  row: RetainedRow,
  releaseSnapshot: string,
  now: number,
  authority: ConnectionAuthority,
): Promise<void> {
  const proof = row.credentialKeysetCommitment;
  if (!proof || !/^[0-9a-f]{64}$/.test(proof)) return;
  const actor = { orgId: row.orgId, authority };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.replay_restore',
    [
      retentionIs(row.id, {
        state: 'pending',
        updated_at: now,
        release_snapshot: releaseSnapshot,
        revision: row.revision + 1,
        credential_keyset_commitment: proof,
      }),
    ],
    row.id,
  );
  g.update('connection_webhook_retention', {
    set: { state: 'failed', error_code: 'WEBHOOK_ENQUEUE_FAILED' },
    inc: ['revision'],
    where: { id: row.id },
  });
  await commitOrNull(g, actor);
}
