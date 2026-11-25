import type { z } from 'zod';
import type {
  OffboardRequestSchema,
  OffboardResultSchema,
} from '../../../shared/contracts/access-business.ts';
import { normalizeEmail } from '../../../shared/email.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { removePass } from '../passes/remove.ts';
import { type Actor, voidPass } from '../passes/service.ts';
import { activeBindingsOn, offboardPasses, offboardTagsGrant } from './repo-offboard.ts';

type Request = z.infer<typeof OffboardRequestSchema>;
type Result = z.infer<typeof OffboardResultSchema>;

const TAG_BATCH = 20;

/**
 * Someone leaves: their passes are voided or removed and their tags let go, or reported lost when
 * they were not handed back. A dry run counts the same and changes nothing.
 */
export async function offboard(
  ctx: ServiceContext,
  actor: Actor,
  authority: TenantPassWrite,
  req: Request,
): Promise<Result> {
  const by = req.holderEmail
    ? { email: normalizeEmail(req.holderEmail) }
    : { externalId: req.externalId as string };
  const passes = await offboardPasses(ctx.env.DB, authority.orgId, authority.mode, by);
  const bindings = await activeBindingsOn(
    ctx.env.DB,
    passes.map((p) => p.id),
  );
  const result = {
    dryRun: req.dryRun,
    holders: new Set(passes.map((p) => p.who)).size,
    passes: passes.length,
    tags: bindings.length,
  };
  if (req.dryRun || passes.length === 0) return result;
  const scope = {
    orgId: authority.orgId,
    mode: authority.mode,
    principal: authority.kind === 'session' ? 'session' : 'api_key',
  } as const;
  // Tags first: removing a pass ends its bindings itself.
  for (let i = 0; i < bindings.length; i += TAG_BATCH)
    await offboardTagsGrant(
      ctx,
      authority,
      authority.orgId,
      bindings.slice(i, i + TAG_BATCH),
      req.tags === 'lost',
    ).commit();
  for (const p of passes) {
    if (req.passes === 'remove') await removePass(ctx, actor, p.id, {}, scope, authority);
    else if (!p.voided) await voidPass(ctx, actor, p.id, scope, authority);
  }
  await recordAudit(ctx, {
    orgId: authority.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action: 'holder.offboard',
    targetType: 'org',
    targetId: authority.orgId,
    detail: { passes: passes.length, tags: bindings.length, how: req.passes, tagsAre: req.tags },
  });
  return result;
}
