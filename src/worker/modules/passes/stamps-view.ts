import { isGoal, maxStamps, stampScope } from '../../../passkit/stamps/rules.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { PassStampsDto } from '../../../shared/contracts/stamps.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from './builder.ts';
import type { Pass } from './repo.ts';

/** A stamp card as its manifest counts it, or null for any other pass. */
export function stampsView(
  manifest: TemplateManifest,
  personalization: Personalization,
): PassStampsDto | null {
  const block = manifest.stamps;
  if (!block || !isGoal(block.goal)) return null;
  const raw = applyDefaults(manifest, personalization)[block.input];
  const count = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  const { card, ready } = stampScope(count, block.goal);
  const props = manifest.inputs?.properties as Record<string, { maximum?: unknown }> | undefined;
  const max = props?.[block.input]?.maximum;
  return {
    input: block.input,
    goal: block.goal,
    count,
    card,
    ready,
    maximum: typeof max === 'number' ? max : maxStamps(block.goal),
  };
}

/** The pass detail's stamp card, read against the pass's own template version. */
export async function stampsOf(
  ctx: ServiceContext,
  pass: Pick<Pass, 'id' | 'orgId' | 'templateId' | 'templateVersion' | 'personalization'>,
): Promise<PassStampsDto | null> {
  try {
    const template = await resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion);
    return stampsView(template.manifest, pass.personalization);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('pass.stamps_unavailable', { passId: pass.id, code: error.code });
    return null;
  }
}
