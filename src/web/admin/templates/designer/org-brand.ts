import { useMemo } from 'react';
import type { BrandPartName } from '@/passkit/template/brand.ts';
import { usePassSetup } from '../../brand/api.ts';
import { brandingUrl } from '../../orgs/queries.ts';

export interface OrgBrand {
  /** The organization's value for the part, when it sets one. */
  logo: { url: string } | null;
  icon: { url: string } | null;
  colors: { background?: string; foreground?: string; label?: string } | null;
}

const NONE: OrgBrand = { logo: null, icon: null, colors: null };

/** What the organization sets for brand, for the designer's From organization rows. */
export function useOrgBrand(orgId: string | undefined): OrgBrand {
  const setup = usePassSetup(orgId ?? '', Boolean(orgId));
  return useMemo(() => {
    const b = orgId ? setup.data?.brand : undefined;
    if (!b || !orgId) return NONE;
    return {
      logo:
        b.logo.source === 'org' && b.logo.value
          ? { url: brandingUrl(orgId, 'logo', b.logo.value.sha) }
          : null,
      icon:
        b.icon.source === 'org' && b.icon.value
          ? { url: brandingUrl(orgId, 'icon', b.icon.value.sha) }
          : null,
      colors: b.passColors.source === 'org' ? (b.passColors.value ?? null) : null,
    };
  }, [orgId, setup.data]);
}

export const isBrandSlot = (slot: string): slot is Extract<BrandPartName, 'logo' | 'icon'> =>
  slot === 'logo' || slot === 'icon';
