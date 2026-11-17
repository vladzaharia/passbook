import { addStamps, redeem } from '../../../passkit/stamps/rules.ts';
import type { PassStampsAction } from '../../../shared/contracts/stamps.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { resolveTemplate } from './builder.ts';
import { detailOf } from './detail.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import { getPass } from './repo-read-pass.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';
import { stampsView } from './stamps-view.ts';

const cause = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');

/**
 * Adds stamps or redeems the reward on one card. Counted from the freshly read pass on every
 * publish attempt, so two desks adding at once both count. The template's messages stay: the
 * stamp that fills the card alerts the holder once, the others and a redeem are silent.
 */
export async function stampPass(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  action: PassStampsAction,
  options: { scope: ScopeArg; authority?: TenantPassWrite },
) {
  const pass = await getPassForWrite(ctx.env.DB, passId, options.scope);
  const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
  if (!stampsView(template.manifest, {}))
    throw new ConflictError('This pass has no stamps.', 'STAMPS_NONE');
  const counts = { from: 0, to: 0 };
  const result = await publishPass(ctx, {
    passId,
    orgScope: options.scope,
    cause: cause(actor),
    actor,
    ...(options.authority ? { authority: options.authority } : {}),
    mutate: (current) => {
      const view = stampsView(template.manifest, current.personalization);
      if (current.templateVersion !== template.version || !view)
        throw new ConflictError('The pass changed. Reload and retry.', 'PASS_CONFLICT');
      const next =
        action.action === 'add'
          ? addStamps(view.count, action.count, view.maximum)
          : redeem(view.count, view.goal);
      if (next === null)
        throw action.action === 'add'
          ? new ConflictError('The card is full. Redeem the reward first.', 'STAMPS_CARD_FULL')
          : new ConflictError(
              `No reward yet: ${view.card} of ${view.goal} stamps.`,
              'STAMPS_NO_REWARD',
            );
      counts.from = view.count;
      counts.to = next;
      return {
        personalization: { ...current.personalization, [view.input]: next },
        fieldSources: { ...current.fieldSources, [view.input]: 'manual' },
      };
    },
  });
  await recordAudit(ctx, {
    orgId: result.pass.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: `pass.stamps.${action.action}`,
    targetType: 'pass',
    targetId: passId,
    detail: { ...counts, published: result.changed },
  });
  return detailOf(
    ctx,
    (await getPass(ctx.env.DB, passId, options.scope)) ?? result.pass,
    options.authority,
  );
}
