import { type EventActorType, EventKindSchema } from '../../../shared/contracts/events.ts';
import type { Grant } from '../../platform/authority.ts';
import { exists } from '../../platform/authority-cond.ts';
import { sealPart } from '../../platform/capability-token.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { redactDetail } from '../audit/redact.ts';
import { grantIssuanceInsert } from '../delivery/repo-issuance.ts';
import { sanitizeEventData } from '../events/record.ts';
import { insertedPassRevisionPart } from './repo-create-read.ts';
import { grantPassInsert } from './repo-write-insert-statement.ts';
import type { NewPassRow } from './repo-write-types.ts';

export interface CreateStatements {
  /** Index of the pass insert (RETURNING id, owner_user_id) in the grant's results. */
  insert: number;
  /** Index of the read of the trigger-assigned revision. */
  revision: number;
}

/**
 * The create batch in one grant: the pass, its commit proof, the issuance delivery, the ledger event,
 * and the audit rows. A missing pass row aborts the batch (`stale`), so nothing partial commits.
 */
export async function addCreateStatements(
  ctx: ServiceContext,
  g: Grant,
  row: NewPassRow,
  ownerUserId: string | null,
): Promise<CreateStatements> {
  const insert = grantPassInsert(g, row, ownerUserId);
  g.assert('stale', [exists('passes', { id: row.id })]);
  g.include(sealPart('pass', row.id, row.downloadToken, row.tokenSeal, { holder: g.pinned }));
  g.include(sealPart('apple-auth', row.id, row.authToken, row.authSeal, { holder: g.pinned }));
  if (row.sendEmail && row.holderEmail) {
    await grantIssuanceInsert(ctx.env.DB, g, row);
    g.assert('stale', [exists('pass_issuance_deliveries', { pass_id: row.id })]);
  }
  const join = row.execution.kind === 'join' ? row.execution : null;
  const actor = { type: (row.actorType ?? 'system') as EventActorType, id: row.actorId };
  g.insertSelect(
    'pass_events',
    ['id', 'kind', 'actor_type', 'actor_id', 'data', 'at'],
    [
      ctx.ids.ordered(row.now),
      EventKindSchema.parse('pass.issued'),
      actor.type,
      actor.id,
      JSON.stringify(
        sanitizeEventData({
          version: 1,
          cause: join ? 'join' : 'create',
          source: null,
          notified: false,
          ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
        }),
      ),
      row.now,
    ],
    { from: { table: 'passes', where: { id: row.id }, copy: { pass_id: 'id' } } },
  );
  if (join)
    g.insertSelect(
      'join_issues',
      ['id', 'link_id', 'link_generation', 'created_at', 'ip_key', 'device_key', 'fields_hash'],
      [
        ctx.ids.id(),
        join.linkId,
        join.generation,
        row.now,
        row.joinKeys?.ipKey ?? null,
        row.joinKeys?.deviceKey ?? null,
        row.joinKeys?.fieldsHash ?? null,
      ],
      { from: { table: 'passes', where: { id: row.id }, copy: { pass_id: 'id' } } },
    );
  if (join)
    g.insertSelect('join_marks', ['created_at'], [row.now], {
      from: { table: 'passes', where: { id: row.id }, copy: { pass_id: 'id' } },
    });
  // The caps count this row: a pass without it would escape them. The mark is what keeps the attach safe.
  if (join)
    g.assert('stale', [
      exists('join_issues', { pass_id: row.id }),
      exists('join_marks', { pass_id: row.id }),
    ]);
  const entry = {
    at: row.now,
    orgId: row.orgId,
    actorType: row.actorType ?? 'system',
    actorId: row.actorId,
    requestId: row.requestId ?? null,
    ipPrefix: null,
  };
  g.audit({
    ...entry,
    action: 'pass.create',
    targetType: 'pass',
    targetId: row.id,
    detail: JSON.stringify(
      redactDetail(
        join
          ? { templateId: row.templateId, joinLinkId: join.linkId }
          : { templateId: row.templateId, connectionId: row.connectionId },
      ),
    ),
  });
  if (ownerUserId !== null)
    g.audit({
      ...entry,
      action: 'holder.attach',
      targetType: 'pass',
      targetId: row.id,
      detail: JSON.stringify({ via: 'email', userId: ownerUserId }),
    });
  const [revision] = g.include(insertedPassRevisionPart(row.id));
  if (!revision) throw new Error('A read part adds one statement.');
  return { insert: g.indexOf(insert), revision: g.indexOf(revision) };
}
