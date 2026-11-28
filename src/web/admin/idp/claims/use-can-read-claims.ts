import { useEffect, useState } from 'react';
import { isRecentSignIn, STEP_UP_SECONDS } from '@/shared/sign-in.ts';
import { useSession } from '@/web/lib/session.ts';

export type ClaimsAccess = 'ok' | 'stale' | 'breakglass';

/**
 * The claims routes want a Polaris ID sign-in from the last STEP_UP_SECONDS; asking without one is a 403.
 * Freshness is re-read when the window regains focus, so a card left open past the window asks to sign in.
 */
export function useClaimsAccess(): ClaimsAccess {
  const { authed } = useSession();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  if (authed?.amr === 'breakglass') return 'breakglass';
  return authed?.amr === 'oidc' && isRecentSignIn(authed.authTime, now, STEP_UP_SECONDS)
    ? 'ok'
    : 'stale';
}
