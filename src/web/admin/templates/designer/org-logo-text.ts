import { useMemo } from 'react';
import { useOrgScope } from '../../../lib/org-filter.tsx';

/** An issued pass shows the org's name beside the logo; the draft card does too. */
function withOrgLogoText(
  passJson: Record<string, unknown> | undefined,
  orgName: string | undefined,
): Record<string, unknown> | null {
  if (!passJson) return null;
  if (!orgName) return passJson;
  const next = { ...passJson };
  for (const key of ['logoText', 'eventLogoText'])
    if (typeof next[key] === 'string') next[key] = orgName;
  return next;
}

export function useOrgBrandedPass(
  passJson: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const orgName = useOrgScope().membership?.orgName;
  return useMemo(() => withOrgLogoText(passJson, orgName), [passJson, orgName]);
}
