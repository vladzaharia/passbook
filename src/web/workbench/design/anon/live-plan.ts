import { PassBuildError } from '../../../../passkit/plan.ts';
import type { ResolvedTemplate } from '../../../../passkit/template/registry.ts';
import type { PassJson, Personalization, TemplateManifest } from '../../../../passkit/types.ts';
import type { InputValues } from '../../playground/model.ts';
import { planPreview } from '../../playground/preview-plan.ts';
import type { AnonBlueprint } from './blueprint.ts';

/**
 * The pass a blueprint's edited values make, planned in the browser by the same planner that built
 * the stored previews. Nothing is fetched. `null` when the values do not make a valid pass, so the
 * card keeps the last one that did; any other error is a defect and is thrown.
 */
export function livePass(
  { preview, doc }: AnonBlueprint,
  values: InputValues,
): Record<string, unknown> | null {
  if (!preview.source) throw new Error('The blueprint has no source to plan from.');
  const template: ResolvedTemplate = {
    id: preview.id,
    version: '1',
    orgId: null,
    origin: 'baked',
    manifest: doc.manifest as unknown as TemplateManifest,
    passJson: preview.source as PassJson,
    assets: preview.assets.map((a) => ({
      name: a.name,
      slot: a.slot as ResolvedTemplate['assets'][number]['slot'],
      scale: a.scale,
      size: 0,
      sha1: '',
      crc32: 0,
      source: { kind: 'inline' },
      ...(a.width ? { width: a.width } : {}),
      ...(a.height ? { height: a.height } : {}),
    })),
    styles: [],
  };
  try {
    return planPreview({
      template,
      input: values as Personalization,
      origin: preview.origin,
    }) as unknown as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PassBuildError) return null;
    throw error;
  }
}
