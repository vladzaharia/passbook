import { Timer } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import type { IdentityMoveSchema } from '@/shared/contracts/identity-moves.ts';
import { armMoveConfirm } from '@/web/lib/confirms-wallet.ts';
import { formatCount, formatStampIn } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import {
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  StatusPill,
  toast,
} from '@/web/ui/index.ts';
import { useOrgNames } from '../../orgs/queries.ts';
import { useOrgTimeZone } from '../../settings/use-org-time-zone.ts';
import { useArmMove, useMoves } from './platform-queries.ts';

type Move = z.infer<typeof IdentityMoveSchema>;

export const KEPT_REASON: Record<string, string> = {
  connection: 'Connection',
  wallet_copy: 'Wallet copy',
  user_tag: 'User tag',
  transfer: 'Transfer',
};

const REASON: Record<string, string> = {
  ...KEPT_REASON,
  kept_both: 'Both live',
  unarmed: 'Unarmed',
};

/** Status vocabulary from lib/status.ts, with the move's own words. */
const STATE: Record<Move['state'], { status: string; label: string }> = {
  planned: { status: 'queued', label: 'Planned' },
  issued: { status: 'running', label: 'Issued' },
  notified: { status: 'sent', label: 'Told' },
  registered: { status: 'verified', label: 'Registered' },
  voided: { status: 'voided', label: 'Voided' },
  kept: { status: 'not_in_use', label: 'Kept' },
  kept_both: { status: 'partial', label: 'Kept both' },
  failed: { status: 'failed', label: 'Failed' },
};

const armable = (m: Move) =>
  m.state !== 'voided' && (m.reason === 'unarmed' || m.state === 'kept_both');

/** The moves of one org: each row's state and reason, with Arm now where a row waits on it. */
export function PlatformMoves({ orgId, operationId }: { orgId: string; operationId?: string }) {
  const list = useMoves(orgId, operationId);
  const zone = useOrgTimeZone(orgId);
  const orgName = useOrgNames()(orgId);
  const arm = useArmMove();
  const [target, setTarget] = useState<Move>();
  const rows = list.data?.items ?? [];
  const columns = useMemo<DataColumnDef<Move, never>[]>(
    () => [
      {
        header: 'Pass',
        id: 'pass',
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.oldPassId.slice(-8)}</span>
        ),
      },
      {
        header: 'State',
        id: 'state',
        cell: ({ row }) => {
          const s = STATE[row.original.state];
          return <StatusPill status={s.status}>{s.label}</StatusPill>;
        },
      },
      {
        header: 'Reason',
        id: 'reason',
        meta: { nowrap: true },
        cell: ({ row }) =>
          row.original.reason ? (REASON[row.original.reason] ?? row.original.reason) : '—',
      },
      {
        header: 'Edits',
        id: 'conflicts',
        meta: { numeric: true, hideBelow: 'md' },
        cell: ({ row }) => formatCount(row.original.conflictCount),
      },
      {
        header: 'Voids',
        id: 'voids',
        meta: { nowrap: true, hideBelow: 'md' },
        cell: ({ row }) => (row.original.voidAt ? formatStampIn(row.original.voidAt, zone) : '—'),
      },
      {
        header: '',
        id: 'actions',
        meta: { nowrap: true },
        cell: ({ row }) =>
          armable(row.original) ? (
            <Button
              size="sm"
              variant="outline"
              iconStart={<Timer aria-hidden />}
              onClick={() => setTarget(row.original)}
            >
              Arm now
            </Button>
          ) : null,
      },
    ],
    [zone],
  );
  const copy = armMoveConfirm();
  return (
    <Card data-platform-moves="">
      <CardHeader title={`Moves: ${orgName}`} />
      {list.isError && rows.length === 0 ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          caption="Moves"
          loading={list.isPending}
          fetching={list.isFetching}
          data={rows}
          getRowId={(m) => m.id}
          empty={<EmptyState art="passes" title="No moves" inline />}
          columns={columns}
        />
      )}
      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => !open && setTarget(undefined)}
        title={copy.title}
        description={copy.description}
        confirmLabel={copy.confirmLabel}
        onConfirm={async () => {
          if (!target) return;
          await arm.mutateAsync(target.id);
          toast.success('Armed');
        }}
      />
    </Card>
  );
}
