import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { getTemplate } from '../templates/repo.ts';
import { getActiveRelease } from '../templates/repo-releases.ts';
import { heldTemplateVersion } from './repo-selection.ts';

/** A template with no release in the mode and no active passes: nothing to read it from yet. */
export class TemplateUnreleasedError extends NotFoundError {}

async function isActiveTemplate(ctx: ServiceContext, templateId: string, orgId: string) {
  const template = await getTemplate(ctx.env.DB, templateId);
  return template?.status === 'active' && (template.orgId === null || template.orgId === orgId);
}

/**
 * A template as a broadcast reads it in `mode`: at the mode's current release, as when a pass is issued.
 * With no current release (an archived template, a withdrawn head) it is the version an active pass
 * holds, newest first, because such passes keep working. A template with neither is not found.
 */
export async function resolveModeTemplate(
  ctx: ServiceContext,
  orgId: string,
  templateId: string,
  mode: Mode,
  /** Read the head's version without verifying its stored content (a scheduled check that only needs the manifest). */
  light = false,
): Promise<{ template: ResolvedTemplate; release: TemplateRelease | null }> {
  if (light) {
    const head = await getActiveRelease(ctx.env.DB, { templateId, orgId, mode, provider: 'apple' });
    if (head && (await isActiveTemplate(ctx, templateId, orgId)))
      return {
        template: await resolveTemplate(ctx, orgId, templateId, head.version),
        release: null,
      };
  }
  const release = light ? null : await activeRelease(ctx, templateId, orgId, mode, 'apple');
  if (release)
    return { template: await resolveTemplate(ctx, orgId, templateId, release.version), release };
  const held = await heldTemplateVersion(ctx.env.DB, orgId, templateId, mode);
  if (!held) {
    const message = `Template ${templateId} has no release in ${mode === 'test' ? 'Test' : 'Live'} and no active passes.`;
    // Only an active template of this org is merely unreleased; a deleted or foreign one is gone.
    if (await isActiveTemplate(ctx, templateId, orgId))
      throw new TemplateUnreleasedError(message, 'TEMPLATE_NOT_FOUND');
    throw new NotFoundError(message, 'TEMPLATE_NOT_FOUND');
  }
  return {
    template: await resolveTemplate(ctx, orgId, templateId, held),
    release: null,
  };
}
