import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { CellContext, ColumnDef } from '@tanstack/react-table';
import { Ban, CircleCheck, IdCard, Pencil, Plus, RotateCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { z } from 'zod';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { formatCount, formatDay } from '@/web/lib/format.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  RowActions,
  StatusPill,
} from '@/web/ui/index.ts';
import { RelTime, useNow } from '../passes/detail/rel-time.tsx';
import {
  type ScanStaff,
  StaffFormDialog,
  StaffPinDialog,
  StaffResetDialog,
  StaffStatusDialog,
} from './staff-dialogs.tsx';

const StaffListSchema = z.object({
  items: z.array(ScanStaffSchema),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().nullish(),
});
const PAGE = 50;
const ROLE_LABEL = { door: 'Door', desk: 'Desk', manager: 'Manager' } as const;

type StaffDialog =
  | { type: 'create' }
  | { type: 'edit'; staff: ScanStaff }
  | { type: 'status'; staff: ScanStaff }
  | { type: 'reset'; staff: ScanStaff }
  | { type: 'pin'; name: string; pin: string };

export function StaffTab() {
  const { orgId, membership } = useOrgScope();
  if (!orgId) {
    return (
      <EmptyState
        art="people"
        title="Select an organization"
        description="Choose an organization above to manage its scanning staff."
      />
    );
  }
  // Changing organizations closes all dialogs, including any one-time PIN reveal.
  const canManage = membership?.capabilities.includes('scanning:manage') ?? false;
  return <OrganizationStaff key={`${orgId}:${canManage}`} orgId={orgId} canManage={canManage} />;
}

function OrganizationStaff({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const client = useQueryClient();
  const mode = useMode();
  const now = useNow();
  const queryKey = ['admin', 'scanning', 'staff', orgId] as const;
  const [dialog, setDialog] = useState<StaffDialog>();
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const staff = useInfiniteQuery({
    queryKey: [...queryKey, mode, q],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/v1/scan-staff', StaffListSchema, {
        query: {
          orgId,
          ...(q ? { q } : {}),
          limit: PAGE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        signal,
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const refresh = () => void client.invalidateQueries({ queryKey });
  // flexRender treats cell callbacks as components, so keep this one stable across
  // refetches and clock ticks rather than remounting an open action menu.
  const actionCell = useCallback(
    ({ row }: CellContext<ScanStaff, never>) => {
      if (!canManage) return null;
      const person = row.original;
      const disabled = person.disabledAt !== null;
      return (
        <RowActions
          label={`Actions for ${person.name}`}
          actions={[
            {
              label: 'Edit',
              icon: Pencil,
              onSelect: () => setDialog({ type: 'edit', staff: person }),
            },
            {
              label: 'Reset PIN',
              icon: RotateCw,
              onSelect: () => setDialog({ type: 'reset', staff: person }),
            },
            {
              label: disabled ? 'Enable' : 'Disable',
              icon: disabled ? CircleCheck : Ban,
              destructive: !disabled,
              onSelect: () => setDialog({ type: 'status', staff: person }),
            },
          ]}
        />
      );
    },
    [canManage],
  );
  const columns: ColumnDef<ScanStaff, never>[] = [
    {
      id: 'name',
      header: 'Name',
      meta: { grow: true },
      cell: ({ row }) => (
        <span className="inline-flex min-w-0 items-center gap-2 font-medium text-fg-strong">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-sunken text-fg-muted">
            <IdCard aria-hidden className="size-4" />
          </span>
          <span className="truncate">{row.original.name}</span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => <Badge>{ROLE_LABEL[row.original.role]}</Badge>,
    },
    {
      id: 'status',
      header: 'Access',
      cell: ({ row }) => (
        <StatusPill status={row.original.disabledAt === null ? 'active' : 'disabled'} />
      ),
    },
    {
      id: 'pin',
      header: 'PIN',
      meta: { nowrap: true },
      cell: ({ row }) =>
        row.original.locked ? (
          <StatusPill status="pin_locked" tone="warning">
            Locked on a scanner
          </StatusPill>
        ) : (
          <span className="text-fg-muted">Set {formatDay(row.original.pinSetAt)}</span>
        ),
    },
    {
      id: 'today',
      header: 'Successful today',
      meta: { numeric: true },
      cell: ({ row }) => (
        <span className="tabular-nums">
          <span aria-hidden>{formatCount(row.original.today)}</span>
          <span className="sr-only">
            {formatCount(row.original.today)} successful, not-undone{' '}
            {row.original.today === 1 ? 'scan' : 'scans'} since each scanner&apos;s local midnight
            for {row.original.name}; removed scanners use UTC
          </span>
        </span>
      ),
    },
    {
      id: 'lastScan',
      header: 'Last scan',
      meta: { hideBelow: 'lg' },
      cell: ({ row }) => {
        const last = row.original.lastScan;
        return last ? (
          <span>
            <RelTime at={last.at} now={now} /> · {last.scannerName}
          </span>
        ) : (
          <span className="text-fg-muted">Never</span>
        );
      },
    },
    {
      id: 'actions',
      header: () => <span className="sr-only">Actions</span>,
      cell: actionCell,
    },
  ];
  const rows =
    staff.data?.pages.flatMap((page) => page.items).filter((person) => person.orgId === orgId) ??
    [];
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface-raised p-4">
        <div>
          <p className="text-sm font-semibold text-fg-strong">Scanning staff</p>
          <p className="mt-1 text-sm text-fg-muted">
            Staff and PINs are shared across live and test. PINs are used when a session requires
            staff sign-in. Activity and PIN locks below reflect {mode === 'test' ? 'Test' : 'Live'}{' '}
            mode. Successful today excludes undone scans and starts at each scanner&apos;s local
            midnight; removed scanners use UTC.
          </p>
        </div>
        {canManage && !staff.isPending && !staff.isError && (rows.length > 0 || q) ? (
          <Button iconStart={<Plus aria-hidden />} onClick={() => setDialog({ type: 'create' })}>
            Add staff
          </Button>
        ) : null}
      </div>
      {staff.isError ? (
        <ErrorState
          inline
          subject="staff"
          error={staff.error}
          title={
            isApiError(staff.error) && staff.error.status === 404
              ? 'Staff management is unavailable for this organization.'
              : undefined
          }
          onRetry={() => staff.refetch()}
        />
      ) : (
        <>
          <FilterBar
            search={{ value: text, onChange: setText, placeholder: 'Search staff' }}
            filters={[]}
            onClear={() => setText('')}
          />
          <DataTable
            caption="Staff"
            data={rows}
            columns={columns}
            getRowId={(person) => person.id}
            loading={staff.isPending}
            fetching={staff.isFetching && !staff.isPending}
            empty={
              <EmptyState
                art="people"
                title={q ? 'No staff match' : 'No staff yet'}
                description={
                  q ? 'Try another name.' : 'Give each person a PIN to see who scanned what.'
                }
                action={
                  canManage && !q ? (
                    <Button onClick={() => setDialog({ type: 'create' })}>Add staff</Button>
                  ) : undefined
                }
              />
            }
          />
          {staff.hasNextPage ? (
            <Button
              variant="ghost"
              disabled={staff.isFetchingNextPage}
              onClick={() => void staff.fetchNextPage()}
            >
              Show more staff
            </Button>
          ) : null}
        </>
      )}
      {canManage && (dialog?.type === 'create' || dialog?.type === 'edit') ? (
        <StaffFormDialog
          orgId={orgId}
          staff={dialog.type === 'edit' ? dialog.staff : undefined}
          onClose={() => setDialog(undefined)}
          onSaved={() => {
            setDialog(undefined);
            refresh();
          }}
          onUncertain={refresh}
          onCreated={(name, pin) => {
            setDialog({ type: 'pin', name, pin });
            refresh();
          }}
        />
      ) : null}
      {canManage && dialog?.type === 'status' ? (
        <StaffStatusDialog
          orgId={orgId}
          staff={dialog.staff}
          onClose={() => setDialog((current) => (current?.type === 'status' ? undefined : current))}
          onSaved={refresh}
        />
      ) : null}
      {canManage && dialog?.type === 'reset' ? (
        <StaffResetDialog
          orgId={orgId}
          staff={dialog.staff}
          onClose={() => setDialog((current) => (current?.type === 'reset' ? undefined : current))}
          onUncertain={refresh}
          onReset={(name, pin) => {
            setDialog({ type: 'pin', name, pin });
            refresh();
          }}
        />
      ) : null}
      {canManage && dialog?.type === 'pin' ? (
        <StaffPinDialog name={dialog.name} pin={dialog.pin} onClose={() => setDialog(undefined)} />
      ) : null}
    </div>
  );
}
