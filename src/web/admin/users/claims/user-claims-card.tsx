import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useClaims, useSetClaims } from '../access/queries.ts';

/** The user's claims; hidden when Polaris ID is not connected. */
export function UserClaimsCard({ userId }: { userId: string }) {
  const claims = useClaims(userId, true);
  const set = useSetClaims(userId);
  return <ClaimsCard hideOnError query={claims} save={(change) => set.mutateAsync(change)} />;
}
