import type { ScanSession } from '../../../shared/contracts/scan-session.ts';

export function customerBrandingOf(session: ScanSession) {
  return {
    name: session.scanner?.orgName ?? session.admin?.orgs[0]?.name ?? 'PassBook',
    accent: session.branding?.accent ?? null,
    logoSha: session.branding?.logo?.sha ?? null,
  };
}
