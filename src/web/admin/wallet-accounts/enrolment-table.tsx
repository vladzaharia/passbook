import { useState } from 'react';
import type {
  PlatformWalletEnrolment,
  WalletProvider,
  WalletRelease,
} from '@/shared/contracts/wallet-providers.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  RowLink,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { COPY, releaseLine, safeError } from './copy.ts';
import { HoldDialog } from './hold-dialog.tsx';
import { usePlatformEnrolments, useWalletActions } from './queries.ts';

const STATE = {
  on: { tone: 'success', label: 'On' },
  off: { tone: 'neutral', label: 'Off' },
  held: { tone: 'warning', label: 'Held' },
  revoked: { tone: 'neutral', label: 'Revoked' },
} as const;

/** Every organization's enrolment of one wallet, Live and Test together, with hold and release. */
export function EnrolmentTable({
  provider,
  releaseState,
}: {
  provider: WalletProvider;
  releaseState?: WalletRelease[WalletProvider] | undefined;
}) {
  const list = usePlatformEnrolments(provider);
  const actions = useWalletActions();
  const [holding, setHolding] = useState<PlatformWalletEnrolment>();
  const [busy, setBusy] = useState<string>();
  async function release(e: PlatformWalletEnrolment) {
    const key = `${e.orgId}:${e.mode}`;
    setBusy(key);
    try {
      await actions.release(e.orgId, e.mode, e.provider);
      toast.success('Released');
    } catch (cause) {
      toast.error(safeError(cause), 'Could not release');
    } finally {
      setBusy(undefined);
    }
  }
  const columns: DataColumnDef<PlatformWalletEnrolment, never>[] = [
    {
      header: 'Organization',
      id: 'org',
      cell: ({ row }) => (
        <RowLink to="/admin/platform/orgs/$orgId" params={{ orgId: row.original.orgId }}>
          {row.original.orgName}
        </RowLink>
      ),
    },
    {
      header: 'Mode',
      id: 'mode',
      meta: { nowrap: true },
      cell: ({ row }) => (row.original.mode === 'test' ? 'Test' : 'Live'),
    },
    {
      header: 'Account',
      id: 'source',
      meta: { nowrap: true, hideBelow: 'md' },
      cell: ({ row }) =>
        row.original.source === 'platform'
          ? COPY.platformSource
          : row.original.source === 'org'
            ? COPY.ownSource
            : 'None',
    },
    {
      header: 'State',
      id: 'state',
      cell: ({ row }) => {
        const s = STATE[row.original.state];
        const dark = releaseState ? releaseLine(provider, releaseState[row.original.mode]) : null;
        return (
          <div className="min-w-0">
            <StatusPill status={row.original.state} tone={s.tone}>
              {s.label}
            </StatusPill>
            {dark ? <p className="mt-1 max-w-[40ch] text-xs text-fg-muted">{dark}</p> : null}
            {row.original.hold ? (
              <p className="mt-1 max-w-[40ch] break-words text-xs text-fg-muted">
                {row.original.hold.reason}
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      header: 'Action',
      id: 'action',
      meta: { nowrap: true },
      cell: ({ row }) => {
        const e = row.original;
        if (e.state === 'revoked') return null;
        const org = `${e.orgName}, ${e.mode === 'test' ? 'Test' : 'Live'}`;
        return e.state === 'held' ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Release ${org}`}
            loading={busy === `${e.orgId}:${e.mode}`}
            onClick={() => void release(e)}
          >
            {COPY.release}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Hold ${org}`}
            onClick={() => setHolding(e)}
          >
            {COPY.hold}
          </Button>
        );
      },
    },
  ];
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isError && rows.length === 0)
    return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
  return (
    <>
      <DataTable
        caption="Organization enrolments"
        loading={list.isPending}
        fetching={list.isFetching && !list.isPending && !list.isFetchingNextPage}
        data={rows}
        getRowId={(e) => `${e.orgId}:${e.mode}`}
        empty={<EmptyState art="wallet" title={COPY.empty} />}
        footer={<LoadMore query={list} shown={rows.length} noun={['enrolment', 'enrolments']} />}
        columns={columns}
      />
      <HoldDialog enrolment={holding} onClose={() => setHolding(undefined)} />
    </>
  );
}
