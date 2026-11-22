import type { BrandPartName } from '@/passkit/template/brand.ts';
import type { UseBlueprintRequest } from '@/shared/contracts/index.ts';
import type { TemplateSummaryDto } from '@/shared/contracts/templates.ts';
import { assetsPayload } from '../templates/designer/images.ts';
import { useLoadBlueprintVersion } from './api.ts';
import type { QuickState } from './quick-fields.tsx';
import { brandDoc, docOfVersion } from './quick-setup.ts';

/**
 * The request for Use: an exact copy, or the draft with the logo, colour and choices put in. A part
 * that goes to the organization's brand is left out of the template; one kept here is the template's own.
 */
export function useBlueprintRequest() {
  const load = useLoadBlueprintVersion();
  return async function request(
    blueprint: Pick<TemplateSummaryDto, 'id' | 'activeVersion'>,
    input: { orgId: string; name: string },
    quick: QuickState,
    toOrg: { logo: boolean; colors: boolean } = { logo: false, colors: false },
  ): Promise<UseBlueprintRequest> {
    const logo = quick.logo && !toOrg.logo ? quick.logo.asset : undefined;
    const color = quick.color && !toOrg.colors ? quick.color : undefined;
    const own: BrandPartName[] = [...(logo ? (['logo'] as const) : []), ...(color ? (['colors'] as const) : [])];
    const touched = own.length > 0 || quick.goal !== undefined || quick.currency !== undefined;
    if (!touched || !blueprint.activeVersion) return input;
    const doc = brandDoc(docOfVersion(await load(blueprint.id, blueprint.activeVersion)), {
      name: input.name,
      color,
      logo,
      goal: quick.goal,
      currency: quick.currency,
      own,
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
