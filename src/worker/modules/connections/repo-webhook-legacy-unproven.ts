import type { ServiceContext } from '../../platform/service-context.ts';
import { commitOrNull, connectionGrant, retentionIs, rowCount } from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

/** True when this call failed the legacy chunk: no pending item is left and it carries no keyset proof. */
export async function failUnprovenLegacyRetention(
  ctx: ServiceContext,
  row: RetainedRow,
  revision: number,
  now: number,
): Promise<boolean> {
  const actor = { orgId: row.orgId };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.fail_legacy',
    [
      retentionIs(row.id, {
        generation: row.generation,
        source: 'legacy',
        state: 'pending',
        revision,
        credential_keyset_commitment: null,
      }),
    ],
    row.id,
  );
  g.update('connection_webhook_retention', {
    set: { state: 'failed', error_code: 'WEBHOOK_EFFECT_UNCERTAIN', updated_at: now },
    inc: ['revision'],
    where: { id: row.id, generation: row.generation, source: 'legacy', state: 'pending', revision },
    returning: ['id'],
  });
  const results = await commitOrNull(g, actor);
  return results ? rowCount(results.at(-1)) === 1 : false;
}
