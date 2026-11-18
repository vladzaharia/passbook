import { Link } from '@tanstack/react-router';
import { useMemo } from 'react';
import type { OrgActivity, TemplateActivity } from '@/shared/contracts/metrics.ts';
import { formatCount } from '@/web/lib/format.ts';
import type { DataColumnDef } from '@/web/ui/data-table-meta.ts';
import { Card, CardHeader, DataTable } from '@/web/ui/index.ts';
import { RANGE_LABEL } from './kpis.tsx';
import type { Range } from './range.ts';

/** In a wallet against not added, as shares of the passes that are live now. */
function WalletBar({ t, index }: { t: TemplateActivity; index: number }) {
  const live = t.inWallet + t.notAdded;
  const label =
    live === 0
      ? `${t.name}: no live passes`
      : `${t.name}: ${formatCount(t.inWallet)} in a wallet, ${formatCount(t.notAdded)} not added`;
  return (
    <div
      role="img"
      aria-label={label}
      className="wl-wallet-bar"
      style={{ '--i': index } as React.CSSProperties}
    >
      {live === 0 ? null : (
        <>
          <span data-part="in" style={{ flexGrow: t.inWallet }} />
          <span data-part="out" style={{ flexGrow: t.notAdded }} />
        </>
      )}
    </div>
  );
}

const num =
  (key: keyof TemplateActivity) =>
  ({ row }: { row: { original: TemplateActivity } }) => (
    <span className="tabular-nums">{formatCount(Number(row.original[key]))}</span>
  );

/** One row per template: the wallet bar, then the counts for the range. */
export function TemplateBreakdown({
  data,
  range,
  canOpen,
}: {
  data: OrgActivity;
  range: Range;
  /** The pass list is open to this member. */
  canOpen: boolean;
}) {
  const order = useMemo(() => new Map(data.templates.map((t, i) => [t.templateId, i])), [data]);
  const columns = useMemo<DataColumnDef<TemplateActivity>[]>(
    () => [
      {
        header: 'Template',
        id: 'name',
        cell: ({ row }) =>
          canOpen ? (
            <Link
              to="/admin/passes"
              search={{ templateId: row.original.templateId }}
              className="font-medium text-fg-strong hover:underline"
            >
              {row.original.name}
            </Link>
          ) : (
            <span className="font-medium text-fg-strong">{row.original.name}</span>
          ),
      },
      {
        header: 'Wallet',
        id: 'wallet',
        cell: ({ row }) => (
          <WalletBar t={row.original} index={order.get(row.original.templateId) ?? 0} />
        ),
      },
      { header: 'In a wallet', id: 'inWallet', meta: { numeric: true }, cell: num('inWallet') },
      { header: 'Not added', id: 'notAdded', meta: { numeric: true }, cell: num('notAdded') },
      { header: 'Issued', id: 'issued', meta: { numeric: true }, cell: num('issued') },
      {
        header: 'Removed',
        id: 'removed',
        meta: { numeric: true, hideBelow: 'lg' },
        cell: num('removed'),
      },
      { header: 'Scans', id: 'scans', meta: { numeric: true }, cell: num('scans') },
      {
        header: 'Redemptions',
        id: 'redemptions',
        meta: { numeric: true, hideBelow: 'lg' },
        cell: num('redemptions'),
      },
    ],
    [canOpen, order],
  );
  return (
    <Card>
      <CardHeader
        title="By template"
        actions={<span className="px-2 text-xs text-fg-muted">{RANGE_LABEL[range]}</span>}
      />
      <DataTable
        bare
        caption="Passes by template"
        data={data.templates}
        columns={columns}
        getRowId={(t) => t.templateId}
      />
    </Card>
  );
}
