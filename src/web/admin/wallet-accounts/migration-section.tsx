import { useState } from 'react';
import type { z } from 'zod';
import type { WalletMigrationItemSchema } from '@/shared/contracts/wallet-providers.ts';
import { type MigrationAction, walletMigrationConfirm } from '@/web/lib/confirms-wallet.ts';
import { formatCount } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  LoadMore,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../orgs/queries.ts';
import { MIGRATION_REASON, PROVIDER_NAME, safeError } from './copy.ts';
import { actionsFor } from './migration-actions.ts';
import { useMigrationActions, useMigrationReport } from './queries.ts';

type Item = z.infer<typeof WalletMigrationItemSchema>;
type Pending = { action: MigrationAction; item?: Item };

const ACTIONS: { action: Exclude<MigrationAction, 'migrate'>; label: string }[] = [
  { action: 'assign_platform', label: 'Use PassBook' },
  { action: 'merge', label: 'Merge' },
  { action: 'retire', label: 'Retire' },
];

/** Platform › Wallet accounts › Migration: legacy accounts waiting for a credential source. */
export function MigrationSection() {
  const report = useMigrationReport();
  const actions = useMigrationActions();
  const orgName = useOrgNames();
  const [pending, setPending] = useState<Pending>();
  const rows = report.data?.pages.flatMap((p) => p.items) ?? [];
  const head = report.data?.pages[0];
  const who = (i: Item) =>
    `${orgName(i.orgId)}, ${PROVIDER_NAME[i.provider]} ${i.mode === 'test' ? 'Test' : 'Live'}`;

  async function confirm() {
    if (!pending) return;
    try {
      if (pending.action === 'migrate') {
        const { queued } = await actions.run();
        toast.success(queued === 1 ? '1 account queued' : `${queued} accounts queued`);
      } else if (pending.item) {
        const { orgId, mode, provider } = pending.item;
        await actions.resolve({ orgId, mode, provider, action: pending.action });
        toast.success('Done');
      }
    } catch (cause) {
      // ConfirmDialog shows a thrown string; keep it to our fixed copy.
      throw safeError(cause);
    }
  }

  const columns: DataColumnDef<Item, never>[] = [
    {
      header: 'Account',
      id: 'account',
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="font-medium text-fg-strong">{orgName(row.original.orgId)}</p>
          <p className="text-xs text-fg-muted">
            {PROVIDER_NAME[row.original.provider]} ·{' '}
            {row.original.mode === 'test' ? 'Test' : 'Live'}
          </p>
        </div>
      ),
    },
    {
      header: 'State',
      id: 'state',
      cell: ({ row }) => {
        const i = row.original;
        return (
          <div className="min-w-0">
            {i.state === 'ready' ? (
              <StatusPill status="queued" tone="info">
                Ready
              </StatusPill>
            ) : (
              <StatusPill status="refused" tone="warning">
                Refused
              </StatusPill>
            )}
            {i.reason ? (
              <p className="mt-1 max-w-[44ch] whitespace-normal break-words text-xs text-fg-muted">
                {MIGRATION_REASON[i.reason] ?? i.reason}
                {i.identityShared.length > 0
                  ? ` Also claimed by ${i.identityShared.map((s) => orgName(s.orgId)).join(', ')}.`
                  : ''}
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      header: 'Action',
      id: 'action',
      cell: ({ row }) =>
        row.original.state === 'refused' ? (
          <div className="flex flex-wrap gap-2">
            {ACTIONS.filter((a) => actionsFor(row.original.reason).includes(a.action)).map((a) => (
              <Button
                key={a.action}
                size="sm"
                variant="outline"
                aria-label={`${a.label} ${who(row.original)}`}
                onClick={() => setPending({ action: a.action, item: row.original })}
              >
                {a.label}
              </Button>
            ))}
          </div>
        ) : null,
    },
  ];

  if (report.isError && rows.length === 0)
    return <ErrorState error={report.error} onRetry={() => report.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      <Callout
        tone={head && head.pending > 0 ? 'warning' : 'success'}
        title={
          head
            ? `${formatCount(head.pending)} pending, ${formatCount(head.migrated)} migrated`
            : 'Loading'
        }
        actionsAside
        actions={
          <Button
            size="sm"
            variant="outline"
            disabled={!head || head.pending === 0}
            onClick={() => setPending({ action: 'migrate' })}
          >
            Run migration
          </Button>
        }
      >
        Serving stays blocked until every account has a credential source.
      </Callout>
      <DataTable
        caption="Legacy wallet accounts"
        loading={report.isPending}
        fetching={report.isFetching && !report.isPending && !report.isFetchingNextPage}
        data={rows}
        getRowId={(i) => i.accountId}
        empty={<EmptyState art="wallet" title="Nothing to migrate" />}
        footer={<LoadMore query={report} shown={rows.length} noun={['account', 'accounts']} />}
        columns={columns}
      />
      <ConfirmDialog
        open={pending !== undefined}
        onOpenChange={(o) => !o && setPending(undefined)}
        {...walletMigrationConfirm(
          pending?.action ?? 'migrate',
          pending?.item ? who(pending.item) : '',
          pending?.item
            ? [pending.item.orgId, ...pending.item.identityShared.map((s) => s.orgId)].map(orgName)
            : [],
        )}
        destructive={pending?.action === 'retire' || pending?.action === 'merge'}
        onConfirm={confirm}
      />
    </div>
  );
}
