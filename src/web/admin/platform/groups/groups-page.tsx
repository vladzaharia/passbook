import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Group } from '@/shared/contracts/idp-access.ts';
import { GROUP_COPY } from '@/shared/copy/idp-platform.ts';
import { ENTITY } from '@/web/lib/entities.ts';
import {
  Button,
  Card,
  CardBody,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  toast,
} from '@/web/ui/index.ts';
import { useIdpStatus } from '../../idp/status-queries.ts';
import { groupColumns } from './group-columns.tsx';
import { DeleteGroupDialog, RenameGroupDialog } from './group-dialogs.tsx';
import { GroupWizard } from './group-wizard.tsx';
import { useGroupActions, useGroups } from './queries.ts';

/** Groups hide while the Polaris ID binding is absent: a page nobody can use shows nothing. */
export function GroupsPage() {
  const status = useIdpStatus();
  if (status.isPending)
    return <PageHeader title="Groups" breadcrumbs={[{ label: 'Platform' }, { label: 'Groups' }]} />;
  if (!status.data?.connected) return <GroupsOff />;
  return <GroupsList />;
}

function GroupsOff() {
  return (
    <>
      <PageHeader title="Groups" breadcrumbs={[{ label: 'Platform' }, { label: 'Groups' }]} />
      <EmptyState art={ENTITY.group.art} title="Polaris ID is not connected" />
    </>
  );
}

function GroupsList() {
  const navigate = useNavigate();
  const list = useGroups();
  const { ensure } = useGroupActions();
  const [wizard, setWizard] = useState(false);
  const [renaming, setRenaming] = useState<Group | null>(null);
  const [deleting, setDeleting] = useState<Group | null>(null);
  const rows = list.data?.items ?? [];
  const hasCustom = rows.some((g) => g.kind === 'custom');
  const columns = useMemo(
    () =>
      groupColumns({
        onRename: setRenaming,
        onDelete: setDeleting,
        creating: ensure.isPending ? ensure.variables : undefined,
        onClaims: (g) =>
          void navigate({
            to: '/admin/platform/groups/$key',
            params: { key: g.key },
            hash: 'claims',
          }),
        onCreate: async (g) => {
          try {
            const sent = await ensure.mutateAsync(g.key as 'console' | 'developer' | 'support');
            toast.success(sent.dryRun ? GROUP_COPY.dryRun : 'Group created in Polaris ID');
          } catch (cause) {
            toast.error(cause, 'Could not create the group');
          }
        },
      }),
    [navigate, ensure],
  );
  return (
    <>
      <PageHeader
        title="Groups"
        breadcrumbs={[{ label: 'Platform' }, { label: 'Groups' }]}
        actions={
          <Button iconStart={<Plus aria-hidden />} onClick={() => setWizard(true)}>
            New group
          </Button>
        }
      />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} subject="groups" onRetry={() => list.refetch()} />
      ) : (
        <div className="flex flex-col gap-6">
          <DataTable
            caption="Groups"
            loading={list.isPending}
            fetching={list.isFetching && !list.isPending}
            data={rows}
            getRowId={(g) => g.key}
            columns={columns}
            empty={<EmptyState art={ENTITY.group.art} title={GROUP_COPY.noGroups} />}
          />
          {list.isSuccess && !hasCustom ? (
            <Card>
              <CardBody>
                <EmptyState
                  inline
                  art={ENTITY.group.art}
                  title={GROUP_COPY.noGroups}
                  action={
                    <Button
                      variant="outline"
                      iconStart={<Plus aria-hidden />}
                      onClick={() => setWizard(true)}
                    >
                      New group
                    </Button>
                  }
                />
              </CardBody>
            </Card>
          ) : null}
        </div>
      )}
      <GroupWizard open={wizard} onOpenChange={setWizard} />
      <RenameGroupDialog group={renaming} onClose={() => setRenaming(null)} />
      <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
