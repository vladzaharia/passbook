import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useClaimsAccess } from '../../idp/claims/use-can-read-claims.ts';
import { useGroupActions, useGroupClaims } from './queries.ts';

export function GroupClaimsCard({ groupKey }: { groupKey: string }) {
  const access = useClaimsAccess();
  const claims = useGroupClaims(groupKey, access === 'ok');
  const { setClaims } = useGroupActions();
  return (
    <ClaimsCard
      id="claims"
      namespaced
      access={access}
      query={claims}
      save={(change) => setClaims.mutateAsync({ key: groupKey, change })}
    />
  );
}
