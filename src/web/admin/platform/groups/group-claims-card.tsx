import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useGroupActions, useGroupClaims } from './queries.ts';

export function GroupClaimsCard({ groupKey }: { groupKey: string }) {
  const claims = useGroupClaims(groupKey);
  const { setClaims } = useGroupActions();
  return (
    <ClaimsCard
      id="claims"
      namespaced
      query={claims}
      save={(change) => setClaims.mutateAsync({ key: groupKey, change })}
    />
  );
}
