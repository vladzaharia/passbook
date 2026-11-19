import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { PageHeader, SkeletonDetail } from '@/web/ui/index.ts';
import { AccessCard } from './org-access.tsx';

/** Mounted behind the org gate, which admits only a members:manage membership. */
export function MembersPage() {
  const { membership } = useOrgScope();
  return (
    <>
      <PageHeader title="Members" />
      {membership ? (
        <AccessCard
          key={membership.orgId}
          org={{ id: membership.orgId, name: membership.orgName }}
        />
      ) : (
        <SkeletonDetail label="Loading members" />
      )}
    </>
  );
}
