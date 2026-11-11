import { rawCheck } from '../../platform/authority-checks.ts';
import { inList } from '../../platform/authority-expr.ts';
import { all } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { AuditActorType } from '../audit/types.ts';
import type { ConnectionAuthority } from './access.ts';
import {
  commitOrNull,
  connectionGrant,
  connectionIs,
  retentionIs,
  rowCount,
} from './repo-grants.ts';
import type { RetainedRow } from './repo-webhook-retention.ts';

const OPERATOR_RESOLVED = 'WEBHOOK_OPERATOR_RESOLVED';

/**
 * One transaction: uncertain items become success (releasing their pass and org fences), the
 * audit row is written only if some item changed, and the chunk closes when nothing else is left.
 * Items that may still be running (`started`) refuse the whole resolution.
 */
export async function resolveUncertainItems(
  ctx: ServiceContext,
  row: RetainedRow,
  p: {
    authority: ConnectionAuthority;
    now: number;
    requestId: string | null;
    actorType: AuditActorType;
    actorId: string | null;
  },
): Promise<{ resolved: number; closed: boolean }> {
  const states = await all<{ state: string; n: number }>(
    ctx.env.DB,
    'SELECT state, COUNT(*) AS n FROM connection_webhook_items WHERE retention_id = ? GROUP BY state',
    [row.id],
  );
  const count = (state: string) => states.find((s) => s.state === state)?.n ?? 0;
  const uncertain = count('uncertain');
  if (uncertain === 0 || count('started') > 0) return { resolved: 0, closed: false };
  const others = states.reduce(
    (n, s) => n + (s.state === 'success' || s.state === 'uncertain' ? 0 : s.n),
    0,
  );
  const actor = { orgId: row.orgId, authority: p.authority };
  const g = connectionGrant(
    ctx,
    actor,
    'webhook.resolve',
    [
      connectionIs({ id: row.connectionId }),
      retentionIs(row.id, { connection_id: row.connectionId, revision: row.revision }),
      rawCheck(
        'retention',
        "EXISTS (SELECT 1 FROM connection_webhook_retention r WHERE r.id = ? AND r.state IN ('failed', 'blocked'))",
        [row.id],
      ),
      rawCheck(
        'retention',
        "NOT EXISTS (SELECT 1 FROM connection_webhook_items s WHERE s.retention_id = ? AND s.state = 'started')",
        [row.id],
      ),
      // The audited count is the count this batch resolves.
      rawCheck(
        'retention',
        "(SELECT COUNT(*) FROM connection_webhook_items s WHERE s.retention_id = ? AND s.state = 'uncertain') = ?",
        [row.id, uncertain],
      ),
    ],
    row.id,
  );
  g.joined('connection_webhook_items', {
    set: { state: 'success', token: null, error_code: OPERATOR_RESOLVED },
    where: { retention_id: row.id, state: 'uncertain' },
    returning: ['ordinal'],
  });
  g.audit({
    at: p.now,
    orgId: row.orgId,
    actorType: p.actorType,
    actorId: p.actorId,
    action: 'connection.webhook_resolve',
    targetType: 'connection',
    targetId: row.connectionId,
    requestId: p.requestId,
    ipPrefix: null,
    detail: JSON.stringify({ retentionId: row.id, resolved: uncertain }),
  });
  const closes = others === 0;
  if (closes)
    g.update('connection_webhook_retention', {
      set: { state: 'resolved', error_code: null, updated_at: p.now },
      inc: ['revision'],
      where: { id: row.id, revision: row.revision, state: inList(['failed', 'blocked']) },
      returning: ['id'],
    });
  const results = await commitOrNull(g, actor);
  if (!results) return { resolved: 0, closed: false };
  return { resolved: rowCount(results[0]), closed: closes && rowCount(results.at(-1)) === 1 };
}
