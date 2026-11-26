import { useMemo } from 'react';
import type { BrandPartName } from '@/passkit/template/brand.ts';
import { usePassSetup } from '../../brand/api.ts';
import { brandingUrl } from '../../orgs/queries.ts';
import { useLoadedUrls } from './assets.ts';

export interface OrgBrand {
  /** The organization's value for the part, when it sets one; `url` is null until it loads. */
  logo: { url: string | null } | null;
  icon: { url: string | null } | null;
  colors: { background?: string; foreground?: string; label?: string } | null;
}

const NONE: OrgBrand = { logo: null, icon: null, colors: null };

/** What the organization sets for brand, for the designer's From organization rows. */
export function useOrgBrand(orgId: string | undefined): OrgBrand {
  const setup = usePassSetup(orgId ?? '', Boolean(orgId));
  const b = orgId ? setup.data?.brand : undefined;
  const logo = orgId && b?.logo.source === 'org' && b.logo.value ? b.logo.value.sha : null;
  const icon = orgId && b?.icon.source === 'org' && b.icon.value ? b.icon.value.sha : null;
  const urls = useLoadedUrls(
    useMemo(
      () => ({
        ...(orgId && logo ? { logo: brandingUrl(orgId, 'logo', logo) } : {}),
        ...(orgId && icon ? { icon: brandingUrl(orgId, 'icon', icon) } : {}),
      }),
      [orgId, logo, icon],
    ),
  );
  return useMemo(() => {
    if (!b || !orgId) return NONE;
    return {
      logo: logo ? { url: urls.logo ?? null } : null,
      icon: icon ? { url: urls.icon ?? null } : null,
      colors: b.passColors.source === 'org' ? (b.passColors.value ?? null) : null,
    };
  }, [orgId, b, logo, icon, urls]);
}

export const isBrandSlot = (slot: string): slot is Extract<BrandPartName, 'logo' | 'icon'> =>
  slot === 'logo' || slot === 'icon';
