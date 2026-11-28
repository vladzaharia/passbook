import { STEP_UP_SECONDS } from '@/shared/sign-in.ts';
import { useSession } from '@/web/lib/session.ts';

export type ClaimsAccess = 'ok' | 'stale' | 'breakglass';

/** The claims routes want a Polaris ID sign-in from the last STEP_UP_SECONDS; asking without one is a 403. */
export function useClaimsAccess(): ClaimsAccess {
  const { authed } = useSession();
  if (authed?.amr === 'breakglass') return 'breakglass';
  const fresh =
    authed?.amr === 'oidc' &&
    authed.authTime != null &&
    Date.now() - authed.authTime <= STEP_UP_SECONDS * 1000;
  return fresh ? 'ok' : 'stale';
}
