import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import { Button, PageHeader, SkeletonDetail } from '@/web/ui/index.ts';
import { MembersDevelopersSlot } from './members-developers-slot.tsx';
import { MembersPanel } from './org-access.tsx';

/** Mounted behind the org gate, which admits only a members:manage membership. */
export function MembersPage() {
  const { membership } = useOrgScope();
  const [inviteOpen, setInviteOpen] = useState(false);
  const personal = membership?.personal === true;
  return (
    <>
      <PageHeader
        title="Members"
        actions={
          membership && !personal ? (
            <Button iconStart={<Plus aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite member
            </Button>
          ) : null
        }
      />
      {membership ? (
        <div className="flex flex-col gap-6">
          <MembersPanel
            key={membership.orgId}
            org={{ id: membership.orgId, name: membership.orgName, personal: membership.personal }}
            inviteOpen={inviteOpen}
            onInviteOpenChange={setInviteOpen}
          />
          <MembersDevelopersSlot orgId={membership.orgId} />
        </div>
      ) : (
        <SkeletonDetail label="Loading members" />
      )}
    </>
  );
}
