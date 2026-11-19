import { useEffect, useState } from 'react';
import { OrgSummarySchema } from '@/shared/contracts/orgs.ts';
import type { ScanBranding } from '@/shared/contracts/scan-session.ts';
import { api } from '@/web/lib/api.ts';
import { brandingUrl } from '../../../orgs/queries.ts';

export interface OrgLook {
  orgName: string;
  branding: ScanBranding;
  logoUrl: string | null;
}

/** The org's name, accent and logo: what the scanner's session carries for the same org. */
export function useOrgLook(orgId: string | null): OrgLook | null {
  const [look, setLook] = useState<OrgLook | null>(null);
  useEffect(() => {
    setLook(null);
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
        () => undefined,
      );
    return () => controller.abort();
  }, [orgId]);
  return look;
}
