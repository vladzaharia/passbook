import type { TemplateManifest } from '../../../passkit/types.ts';
import type { Check } from '../../platform/authority-checks.ts';
import { ConflictError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import { getPassForWrite } from './pass-access.ts';
import { type ExternalIdScope, externalIdFreeCheck, externalIdTaken } from './repo-external-id.ts';
import type { ScopeArg } from './scope.ts';

/** The template asks for one pass per external id (per org and mode). */
export const uniqueExternalIds = (manifest: Pick<TemplateManifest, 'externalId'>): boolean =>
  manifest.externalId?.unique === true;

/** Deleted passes release their id; removed and voided ones keep it. */
export async function assertExternalIdFree(
  db: D1Database,
  scope: ExternalIdScope,
  externalId: string,
  exceptPassId?: string,
): Promise<void> {
  if (await externalIdTaken(db, scope, externalId, exceptPassId))
    throw new ConflictError(
      'Another pass of this template has that externalId. Use a new one or update that pass.',
      'EXTERNAL_ID_TAKEN',
    );
}

/**
 * For an update that moves a pass to a new externalId on a template with the rule: the pre-check
 * (throws EXTERNAL_ID_TAKEN) and the check the write repeats, so a concurrent create cannot slip past.
 */
export async function externalIdUpdateGuard(
  ctx: ServiceContext,
  passId: string,
  scope: ScopeArg,
  externalId: string,
  templateVersion: string | undefined,
): Promise<{ scope: ExternalIdScope; value: string; check: Check } | undefined> {
  const target = await getPassForWrite(ctx.env.DB, passId, scope);
  if (!target || externalId === target.externalId) return undefined;
  const template = await resolveTemplate(
    ctx,
    target.orgId,
    target.templateId,
    templateVersion ?? target.templateVersion,
  );
  if (!uniqueExternalIds(template.manifest)) return undefined;
  const where = { orgId: target.orgId, mode: target.mode, templateId: target.templateId };
  await assertExternalIdFree(ctx.env.DB, where, externalId, passId);
  return {
    scope: where,
    value: externalId,
    check: externalIdFreeCheck(target.templateId, externalId, passId),
  };
}
