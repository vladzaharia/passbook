import { useEffect, useState } from 'react';
import { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import type { ScanBranding } from '@/shared/contracts/scan-session.ts';
import { useToolApi } from '@/web/lib/tool-api.tsx';
import { brandingUrl } from '../../../orgs/queries.ts';

export interface OrgLook {
  orgName: string;
  branding: ScanBranding;
  logoUrl: string | null;
}

/** What the preview wears until the org's own look is known, or when it has none: no brand. */
export const NEUTRAL_LOOK: OrgLook = {
  orgName: 'Organization',
  branding: { accent: null, logo: null },
  logoUrl: null,
};

/**
 * The org's name, accent and logo: what the scanner's session carries for the same org. While it
 * loads, or if it cannot be read (`failed`), the preview shows neutral branding.
 */
export function useOrgLook(orgId: string | null): { look: OrgLook; failed: boolean } {
  const api = useToolApi();
  const [look, setLook] = useState<OrgLook>(NEUTRAL_LOOK);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setLook(NEUTRAL_LOOK);
    setFailed(false);
    if (!orgId) return;
    const controller = new AbortController();
    void api
      .get(`/api/v1/orgs/${encodeURIComponent(orgId)}/workspace`, OrgSummarySchema, {
        signal: controller.signal,
      })
      .then(
        (org) => {
          const { accent, logo } = org.branding;
          setLook({
            orgName: org.name,
            branding: { accent: accent ?? null, logo: logo ?? null },
            logoUrl: logo ? brandingUrl(orgId, 'logo', logo.sha) : null,
          });
        },
        () => {
          if (!controller.signal.aborted) setFailed(true);
        },
      );
    return () => controller.abort();
  }, [api, orgId]);
  return { look, failed };
}
