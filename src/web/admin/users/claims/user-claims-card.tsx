import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useClaimsAccess } from '../../idp/claims/use-can-read-claims.ts';
import { useClaims, useSetClaims } from '../access/queries.ts';

/** The user's claims; hidden when Polaris ID is not connected. */
export function UserClaimsCard({ userId }: { userId: string }) {
  const access = useClaimsAccess();
  const claims = useClaims(userId, access === 'ok');
  const set = useSetClaims(userId);
  return (
    <ClaimsCard
      hideOnError
      access={access}
      query={claims}
      save={(change) => set.mutateAsync(change)}
    />
  );
}
