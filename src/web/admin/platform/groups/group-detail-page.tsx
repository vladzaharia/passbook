import { useNavigate } from '@tanstack/react-router';
import { Cloud, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import { ApiError } from '@/web/lib/errors.ts';
import {
  Button,
  Callout,
  Card,
  CardBody,
  CardHeader,
  detailError,
  EmptyState,
  KeyValue,
  PageHeader,
  SkeletonDetail,
  TwoPane,
  toast,
} from '@/web/ui/index.ts';
import { useIdpStatus } from '../../idp/status-queries.ts';
import { GroupClaimsCard } from './group-claims-card.tsx';
import { DeleteGroupDialog, RenameGroupDialog } from './group-dialogs.tsx';
import { GroupMembersCard } from './group-members-card.tsx';
import { GroupRulesCard } from './group-rules-card.tsx';
import {
  deleteBlock,
  flagText,
  GroupKindPill,
  groupLabel,
  needsCreate,
  setBy,
} from './group-ui.tsx';
import { useGroup, useGroupActions } from './queries.ts';

/** One group: where its members come from, org rules, manual members and claims. */
export function GroupDetailPage({ groupKey }: { groupKey: string }) {
  const status = useIdpStatus();
  const crumbs = [{ label: 'Groups', to: '/admin/platform/groups' }, { label: groupKey }];
  if (status.isPending) return <PageHeader title="Group" breadcrumbs={crumbs} />;
  if (!status.data?.connected)
    return (
      <>
        <PageHeader title="Group" breadcrumbs={crumbs} />
        <EmptyState art={ENTITY.group.art} title="Polaris ID is not connected" />
      </>
    );
  return <Detail groupKey={groupKey} />;
}

function Detail({ groupKey }: { groupKey: string }) {
  const navigate = useNavigate();
  const query = useGroup(groupKey);
  const { ensure } = useGroupActions();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const group = query.data;
  const crumbs = [
    { label: 'Groups', to: '/admin/platform/groups' },
    { label: group ? groupLabel(group) : groupKey },
  ];
  if (query.isPending) {
    return (
      <>
        <PageHeader title="Group" breadcrumbs={crumbs} />
        <SkeletonDetail label="Loading group" />
      </>
    );
  }
  if (query.isError || !group) {
    return detailError(
      query.isError
        ? query
        : {
            error: new ApiError({
              status: 404,
              code: 'GROUP_NOT_FOUND',
              detail: 'Group not found.',
            }),
            refetch: query.refetch,
          },
      {
        entity: 'group',
        to: '/admin/platform/groups',
        header: <PageHeader title="Group" breadcrumbs={crumbs} />,
      },
    );
  }
  const block = deleteBlock(group);
  const sourced = group.kind !== 'role';
  return (
    <>
      <PageHeader
        title={groupLabel(group)}
        breadcrumbs={crumbs}
        meta={
          <>
            <GroupKindPill kind={group.kind} />
            <code className="font-mono text-xs">{group.name}</code>
          </>
        }
        actions={
          needsCreate(group) ? (
            <Button
              loading={ensure.isPending}
              iconStart={<Cloud aria-hidden />}
              onClick={async () => {
                try {
                  const sent = await ensure.mutateAsync(
                    group.key as 'console' | 'developer' | 'support',
                  );
                  toast.success(sent.dryRun ? GROUP_COPY.dryRun : 'Group created in Polaris ID');
                } catch (cause) {
                  toast.error(cause, 'Could not create the group');
                }
              }}
            >
              Create in Polaris ID
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                iconStart={<Pencil aria-hidden />}
                onClick={() => setRenaming(true)}
              >
                Rename
              </Button>
              {block === 'hidden' ? null : (
                <Button
                  variant="outline"
                  disabled={block !== null}
                  iconStart={<Trash2 aria-hidden />}
                  onClick={() => setDeleting(true)}
                >
                  Delete
                </Button>
              )}
            </>
          )
        }
      />
      <TwoPane
        aside={
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <KeyValue
                items={[
                  { label: 'Members', value: group.members === null ? '—' : String(group.members) },
                  { label: 'Set by', value: setBy(group) },
                  {
                    label: 'Other apps',
                    value: group.otherClients === null ? '—' : String(group.otherClients),
                  },
                  { label: 'Polaris ID name', value: group.name, mono: true },
                ]}
              />
            </CardBody>
          </Card>
        }
      >
        {group.flags.length > 0 ? (
          <Callout tone="warning" items={group.flags.map(flagText)} />
        ) : null}
        {block && block !== 'hidden' ? (
          <Callout tone="info">Can't delete yet. {block}</Callout>
        ) : null}
        {sourced ? <GroupRulesCard groupKey={group.key} /> : null}
        {sourced ? <GroupMembersCard groupKey={group.key} /> : null}
        <GroupClaimsCard groupKey={group.key} />
      </TwoPane>
      <RenameGroupDialog group={renaming ? group : null} onClose={() => setRenaming(false)} />
      <DeleteGroupDialog
        group={deleting ? group : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => void navigate({ to: '/admin/platform/groups', replace: true })}
      />
    </>
  );
}
