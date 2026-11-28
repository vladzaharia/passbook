import { ClaimsCard } from '../../idp/claims/claims-card.tsx';
import { useCanReadClaims } from '../../idp/claims/use-can-read-claims.ts';
import { useGroupActions, useGroupClaims } from './queries.ts';

export function GroupClaimsCard({ groupKey }: { groupKey: string }) {
  const allowed = useCanReadClaims();
  const claims = useGroupClaims(groupKey, allowed);
  const { setClaims } = useGroupActions();
  if (!allowed) return null;
  return (
    <ClaimsCard
      id="claims"
      namespaced
      query={claims}
      save={(change) => setClaims.mutateAsync({ key: groupKey, change })}
    />
  );
}
