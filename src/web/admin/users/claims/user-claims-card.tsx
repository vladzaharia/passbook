import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useCanReadClaims } from '../../idp/claims/use-can-read-claims.ts';
import { useClaims, useSetClaims } from '../access/queries.ts';

/** The user's claims; hidden when Polaris ID is not connected or the session cannot read them. */
export function UserClaimsCard({ userId }: { userId: string }) {
  const allowed = useCanReadClaims();
  const claims = useClaims(userId, allowed);
  const set = useSetClaims(userId);
  if (!allowed) return null;
  return <ClaimsCard hideOnError query={claims} save={(change) => set.mutateAsync(change)} />;
}
