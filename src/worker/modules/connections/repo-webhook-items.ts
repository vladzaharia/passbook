import { rawCheck } from '../../platform/authority-checks.ts';
import { all, first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  commitOrNull,
  connectionGrant,
  connectionIs,
  itemReleaseMatches,
  retentionIs,
  rowCount,
} from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

export { claimSnapshot, startExistingItem, startNewItem } from './repo-webhook-item-claims.ts';
export {
  parkItem,
  parkUnexpectedBinding,
  parkUnprovenLegacyItems,
} from './repo-webhook-item-park.ts';

export type WebhookItemState =
  | 'pending'
  | 'started'
  | 'success'
  | 'blocked'
  | 'failed'
  | 'uncertain';
export type WebhookItemOutcome = 'success' | 'blocked' | 'failed' | 'retry' | 'uncertain';

export interface ItemSummary {
  pending: number;
  started: number;
  success: number;
  blocked: number;
  failed: number;
  uncertain: number;
  blockedCode: string | null;
  failedCode: string | null;
}

export async function itemState(
  db: D1Database,
  id: string,
  ordinal: number,
): Promise<WebhookItemState | null> {
  const row = await first<{ state: WebhookItemState }>(
    db,
    'SELECT state FROM connection_webhook_items WHERE retention_id = ? AND ordinal = ?',
    [id, ordinal],
  );
  return row?.state ?? null;
}

const itemActor = (row: RetainedRow) => ({ orgId: row.orgId });

/** A no-effect item is terminal without ever acquiring an unbound in-flight token. */
export async function finishNoEffect(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  ref: string,
): Promise<boolean> {
  const actor = itemActor(row);
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.item_finish',
    [
      connectionIs({
        id: row.connectionId,
        generation: row.generation,
        syncMode: row.connectionMode,
        enabled: true,
      }),
      retentionIs(row.id, {
        source: 'ingress',
        snapshot_known: 1,
        state: 'pending',
        revision: row.revision,
        generation: row.generation,
        credential_keyset_commitment: row.credentialKeysetCommitment,
      }),
      itemReleaseMatches(row.id, ordinal),
      rawCheck(
        'lineage',
        'NOT EXISTS (SELECT 1 FROM passes p WHERE p.connection_id = ? AND p.external_ref = ?)',
        [row.connectionId, ref],
      ),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: { state: 'success', error_code: null },
    where: {
      retention_id: row.id,
      ordinal,
      state: 'pending',
      prior_unknown: 0,
      claim_kind: null,
      claim_pass_id: null,
      claim_prior_unbound: 0,
    },
    returning: ['ordinal'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

export async function finishItem(
  ctx: ServiceContext,
  row: RetainedRow,
  ordinal: number,
  token: string,
  outcome: WebhookItemOutcome,
  code: string | null,
  credentialKeysetCommitment: string,
): Promise<boolean> {
  const state = outcome === 'retry' ? 'pending' : outcome;
  const actor = itemActor(row);
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.item_complete',
    [
      retentionIs(row.id, {
        generation: row.generation,
        state: 'pending',
        revision: row.revision,
        credential_keyset_commitment: credentialKeysetCommitment,
      }),
      rawCheck(
        'retention',
        `EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.retention_id = ? AND i.ordinal = ?
          AND i.claim_pass_id IS NOT NULL
          AND json_extract(i.claim_snapshot, '$.credentialKeysetCommitment') = ?)`,
        [row.id, ordinal, credentialKeysetCommitment],
      ),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: { state, token: null, error_code: code },
    where: {
      retention_id: row.id,
      ordinal,
      state: 'started',
      token,
      claim_revision: row.revision,
    },
    returning: ['ordinal'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}

export async function summarizeItems(
  db: D1Database,
  row: RetainedRow,
): Promise<ItemSummary | null> {
  const rows = await all<{
    state: WebhookItemState;
    n: number;
    code: string | null;
    stale: number;
  }>(
    db,
    `SELECT state, COUNT(*) AS n, MIN(error_code) AS code,
       MAX(CASE WHEN error_code = 'WEBHOOK_RELEASE_STALE' THEN 1 ELSE 0 END) AS stale
     FROM connection_webhook_items WHERE retention_id = ? GROUP BY state`,
    [row.id],
  );
  const result: ItemSummary = {
    pending: 0,
    started: 0,
    success: 0,
    blocked: 0,
    failed: 0,
    uncertain: 0,
    blockedCode: null,
    failedCode: null,
  };
  let count = 0;
  for (const item of rows) {
    result[item.state] = item.n;
    count += item.n;
    if (item.state === 'blocked') result.blockedCode = item.code;
    if (item.state === 'failed')
      result.failedCode = item.stale ? 'WEBHOOK_RELEASE_STALE' : item.code;
  }
  return count === row.itemCount ? result : null;
}
