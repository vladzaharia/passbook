import { STEP_UP_SECONDS } from '@/shared/sign-in.ts';
import { useSession } from '@/web/lib/session.ts';
import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useClaims, useSetClaims } from '../access/queries.ts';

/** The user's claims; hidden when Polaris ID is not connected or the session cannot read them. */
export function UserClaimsCard({ userId }: { userId: string }) {
  const { authed } = useSession();
  // The route wants a Polaris ID sign-in from the last STEP_UP_SECONDS; asking without one is a 403.
  const allowed =
    authed?.amr === 'oidc' &&
    authed.authTime != null &&
    Date.now() - authed.authTime <= STEP_UP_SECONDS * 1000;
  const claims = useClaims(userId, allowed);
  const set = useSetClaims(userId);
  if (!allowed) return null;
  return <ClaimsCard hideOnError query={claims} save={(change) => set.mutateAsync(change)} />;
}
