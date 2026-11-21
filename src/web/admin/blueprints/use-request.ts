import type { UseBlueprintRequest } from '@/shared/contracts/index.ts';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { assetsPayload } from '../templates/designer/images.ts';
import { useLoadBlueprintVersion } from './api.ts';
import type { QuickState } from './quick-fields.tsx';
import { brandDoc, docOfVersion } from './quick-setup.ts';

/** The request for Use: an exact copy, or the draft with the logo, colour and choices put in. */
export function useBlueprintRequest() {
  const load = useLoadBlueprintVersion();
  return async function request(
    blueprint: Pick<TemplateSummaryDto, 'id' | 'activeVersion'>,
    input: { orgId: string; name: string },
    quick: QuickState,
  ): Promise<UseBlueprintRequest> {
    if (!quick.touched || !blueprint.activeVersion) return input;
    const doc = brandDoc(docOfVersion(await load(blueprint.id, blueprint.activeVersion)), {
      name: input.name,
      color: quick.color,
      logo: quick.logo?.asset,
      goal: quick.goal,
      currency: quick.currency,
    });
    return {
      ...input,
      version: {
        passJson: doc.passJson,
        manifest: doc.manifest as never,
        assets: assetsPayload(doc.assets),
      },
    };
  };
}
