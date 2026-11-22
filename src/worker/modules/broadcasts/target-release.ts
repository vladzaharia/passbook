import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Mode } from '../../../shared/contracts/common.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { activeRelease, type TemplateRelease } from '../templates/releases.ts';
import { heldTemplateVersion } from './repo-selection.ts';

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
): Promise<{ template: ResolvedTemplate; release: TemplateRelease | null }> {
  const release = await activeRelease(ctx, templateId, orgId, mode, 'apple');
  if (release)
    return { template: await resolveTemplate(ctx, orgId, templateId, release.version), release };
  const held = await heldTemplateVersion(ctx.env.DB, orgId, templateId, mode);
  if (!held)
    throw new NotFoundError(
      `Template ${templateId} has no release in ${mode === 'test' ? 'Test' : 'Live'} and no active passes.`,
      'TEMPLATE_NOT_FOUND',
    );
  return {
    template: await resolveTemplate(ctx, orgId, templateId, held),
    release: null,
  };
}
