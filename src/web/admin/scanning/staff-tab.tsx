import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, IdCard, LockOpen, Pencil, Plus, RotateCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { z } from 'zod';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import { api } from '@/web/lib/api.ts';
import { useDebounced } from '@/web/lib/debounce.ts';
import { isApiError } from '@/web/lib/errors.ts';
import { useMode } from '@/web/lib/mode.ts';
import { useOrgScope } from '@/web/lib/org-filter.tsx';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
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
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { RelTime, useNow } from '../../ui/rel-time.tsx';
import {
  type ScanStaff,
  StaffPinDialog,
  StaffResetDialog,
  StaffStatusDialog,
} from './staff-dialogs.tsx';
import { StaffFormDialog } from './staff-form-dialog.tsx';
import {
  type PinToolDialog,
  StaffPinCell,
  StaffPinToolDialog,
  StaffTodayCell,
} from './staff-pin-cells.tsx';
import { StaffPinOnlyNotice } from './staff-pin-only-notice.tsx';

const StaffListSchema = z.object({
  items: z.array(ScanStaffSchema),
  pinOnlyOff: z.literal(true).optional(),
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
  | { type: 'pin'; name: string; pin: string }
  | PinToolDialog;

export function StaffTab() {
  const { orgId, membership } = useOrgScope();
  if (!orgId) {
    return <OrgChooser inline />;
  }
  // Changing organizations closes all dialogs, including any one-time PIN reveal.
  const canManage = membership?.capabilities.includes('scanning:manage') ?? false;
  return (
    <OrganizationStaff
      key={`${orgId}:${canManage}`}
      orgId={orgId}
      canManage={canManage}
      canTurnOnPinOnly={membership?.capabilities.includes('org:manage') ?? false}
    />
  );
}

function OrganizationStaff({
  orgId,
  canManage,
  canTurnOnPinOnly,
}: {
  orgId: string;
  canManage: boolean;
  canTurnOnPinOnly: boolean;
}) {
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
    ({ row }: { row: { original: ScanStaff } }) => {
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
            ...(person.pinLockedToday
              ? [
                  {
                    label: 'Unlock PIN',
                    icon: LockOpen,
                    onSelect: () => setDialog({ type: 'unlock', staff: person }),
                  },
                ]
              : []),
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
  const columns: DataColumnDef<ScanStaff, never>[] = [
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
      cell: ({ row }) => <StaffPinCell person={row.original} />,
    },
    {
      id: 'today',
      header: 'Successful today',
      meta: { numeric: true },
      cell: ({ row }) => <StaffTodayCell person={row.original} />,
    },
    {
      id: 'lastScan',
      header: 'Last scan',
      meta: { hideBelow: 'md' },
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
  // No staff yet: the empty state and its Add button stand alone, without a banner or a search.
  const bare = !staff.isPending && !staff.isError && rows.length === 0 && !q;
  return (
    <div className="grid gap-4">
      {staff.data?.pages[0]?.pinOnlyOff ? (
        <StaffPinOnlyNotice orgId={orgId} canTurnOn={canTurnOnPinOnly} onTurnedOn={refresh} />
      ) : null}
      {bare ? null : (
        <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface-raised p-4">
          <p className="text-sm text-fg-muted">
            Shared by Live and Test. Counts show {mode === 'test' ? 'Test' : 'Live'} scans today,
            not undone.
          </p>
          {canManage && !staff.isPending && !staff.isError && (rows.length > 0 || q) ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setDialog({ type: 'untagged' })}>
                Reset untagged PINs
              </Button>
              <Button
                iconStart={<Plus aria-hidden />}
                onClick={() => setDialog({ type: 'create' })}
              >
                Add staff
              </Button>
            </div>
          ) : null}
        </div>
      )}
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
          {bare ? null : (
            <FilterBar
              search={{ value: text, onChange: setText, placeholder: 'Search staff' }}
              filters={[]}
              onClear={() => setText('')}
            />
          )}
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
      {canManage && (dialog?.type === 'unlock' || dialog?.type === 'untagged') ? (
        <StaffPinToolDialog
          orgId={orgId}
          dialog={dialog}
          onClose={() => setDialog(undefined)}
          onDone={refresh}
        />
      ) : null}
      {canManage && dialog?.type === 'pin' ? (
        <StaffPinDialog name={dialog.name} pin={dialog.pin} onClose={() => setDialog(undefined)} />
      ) : null}
    </div>
  );
}
