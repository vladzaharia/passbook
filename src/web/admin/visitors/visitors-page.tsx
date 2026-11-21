import { Ban, LogOut, Mail, MailCheck, Plus } from 'lucide-react';
import { useState } from 'react';
import type { Visitor } from '@/shared/contracts/visitors.ts';
import { VISITOR_COPY } from '@/shared/copy/visitors.ts';
import { ForbiddenPage } from '@/web/ui/layout/error-pages.tsx';
import { ENTITY } from '../../lib/entities.ts';
import { useOrgScope } from '../../lib/org-filter.tsx';
import { cancelVisitConfirm, STATUS_TONE, statusLine, whenLine } from '../../lib/visitors.ts';
import type { DataColumnDef } from '../../ui/data-table-meta.ts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  RowActions,
  SegmentedControl,
  SkeletonRows,
  StatusPill,
  toast,
} from '../../ui/index.ts';
import {
  useResendHostEmail,
  useResendInvite,
  useVisitorAction,
  useVisitors,
  type VisitTab,
} from './api.ts';
import { NewVisitorDialog } from './new-visitor-dialog.tsx';

const TABS = (['today', 'upcoming', 'past'] as const).map((value) => ({
  value,
  label: VISITOR_COPY.tabs[value],
}));

export interface VisitorsSearch {
  tab?: VisitTab | undefined;
}

export function VisitorsPage({
  search,
  onSearch,
}: {
  search: VisitorsSearch;
  onSearch: (patch: VisitorsSearch) => void;
}) {
  const scope = useOrgScope();
  if (scope.isLoading) return <SkeletonRows label="Loading organization access" />;
  if (scope.isError)
    return <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  if (!scope.orgId || !scope.membership?.capabilities.includes('passes:read'))
    return <ForbiddenPage />;
  return (
    <ScopedVisitors
      key={scope.orgId}
      orgId={scope.orgId}
      canOperate={scope.membership.capabilities.includes('passes:operate')}
      tab={search.tab ?? 'today'}
      onTab={(tab) => onSearch({ tab: tab === 'today' ? undefined : tab })}
    />
  );
}

function ScopedVisitors({
  orgId,
  canOperate,
  tab,
  onTab,
}: {
  orgId: string;
  canOperate: boolean;
  tab: VisitTab;
  onTab: (tab: VisitTab) => void;
}) {
  const list = useVisitors(orgId, tab);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState<Visitor>();
  const checkOut = useVisitorAction(orgId, 'check-out');
  const cancel = useVisitorAction(orgId, 'cancel');
  const hostEmail = useResendHostEmail(orgId);
  const invite = useResendInvite();
  const rows = list.data?.items ?? [];

  const actionsOf = (v: Visitor) => [
    ...(canOperate && v.hasEmail && v.status === 'expected'
      ? [
          {
            label: 'Resend invite',
            icon: Mail,
            onSelect: () =>
              void invite
                .mutateAsync(v)
                .then(() => toast.sent(`Invite sent to ${v.name}`))
                .catch((e: unknown) => toast.error(e, 'Could not send')),
          },
        ]
      : []),
    ...(canOperate && (v.status === 'in' || (v.status === 'out' && !v.autoOut))
      ? [
          {
            label: 'Email host again',
            icon: MailCheck,
            onSelect: () =>
              void hostEmail
                .mutateAsync(v)
                .then(() => toast.success('Host emailed'))
                .catch((e: unknown) => toast.error(e, 'Could not send')),
          },
        ]
      : []),
    ...(canOperate && v.status === 'in'
      ? [
          {
            label: VISITOR_COPY.menu.checkOut,
            icon: LogOut,
            onSelect: () =>
              void checkOut
                .mutateAsync(v)
                .then(() => toast.success(VISITOR_COPY.toast.out))
                .catch((e: unknown) => toast.error(e, 'Could not check out')),
          },
        ]
      : []),
    ...(canOperate && v.status === 'expected'
      ? [
          {
            label: VISITOR_COPY.menu.cancel,
            icon: Ban,
            destructive: true,
            onSelect: () => setCancelling(v),
          },
        ]
      : []),
  ];

  const columns: DataColumnDef<Visitor, never>[] = [
    {
      id: 'visitor',
      header: VISITOR_COPY.columns.visitor,
      cell: ({ row }) => (
        <div className="min-w-0 max-w-80">
          <span className="block truncate font-medium text-fg-strong">{row.original.name}</span>
          {row.original.note ? (
            <span className="block truncate text-xs text-fg-muted">{row.original.note}</span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'host',
      header: VISITOR_COPY.columns.host,
      meta: { hideBelow: 'md', stackHidden: false },
      cell: ({ row }) => row.original.hostName,
    },
    {
      id: 'when',
      header: VISITOR_COPY.columns.when,
      meta: { nowrap: true },
      cell: ({ row }) => whenLine(row.original.windowFrom, row.original.windowUntil),
    },
    {
      id: 'status',
      header: VISITOR_COPY.columns.status,
      meta: { nowrap: true },
      cell: ({ row }) => (
        <StatusPill status={row.original.status} tone={STATUS_TONE[row.original.status]}>
          {statusLine(row.original)}
        </StatusPill>
      ),
    },
    {
      id: 'actions',
      header: '',
      meta: { nowrap: true },
      cell: ({ row }) => (
        <RowActions label={`Actions for ${row.original.name}`} actions={actionsOf(row.original)} />
      ),
    },
  ];

  const add = canOperate ? (
    <Button iconStart={<Plus aria-hidden />} onClick={() => setAdding(true)}>
      {VISITOR_COPY.new}
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title={VISITOR_COPY.title}
        actions={!list.isPending && !list.isError && rows.length === 0 ? null : add}
      />
      <div className="mb-4">
        <SegmentedControl label="Visitors" options={TABS} value={tab} onValueChange={onTab} />
      </div>
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <DataTable
          caption={VISITOR_COPY.title}
          columns={columns}
          data={rows}
          getRowId={(r) => r.id}
          loading={list.isPending}
          fetching={list.isFetching}
          empty={
            <EmptyState
              art={ENTITY.visitor.art}
              title={VISITOR_COPY.empty[tab]}
              action={add ?? undefined}
            />
          }
        />
      )}
      {canOperate ? (
        <NewVisitorDialog open={adding} onOpenChange={setAdding} orgId={orgId} />
      ) : null}
      <ConfirmDialog
        open={cancelling !== undefined}
        onOpenChange={(open) => !open && setCancelling(undefined)}
        {...cancelVisitConfirm(cancelling?.name ?? '')}
        destructive
        onConfirm={async () => {
          if (!cancelling) return;
          await cancel.mutateAsync(cancelling);
          toast.success(VISITOR_COPY.toast.cancelled);
        }}
      />
    </>
  );
}
