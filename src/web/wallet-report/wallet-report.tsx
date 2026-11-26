import { type ReactNode, useEffect, useState } from 'react';
import { statusLabel } from '@/passkit/wallets/fidelity.ts';
import type { FidelityReportDto } from '@/shared/contracts/wallet-fidelity.ts';
import { PREVIEW_COPY, walletName } from '@/shared/copy/previews.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { useChangeCount } from '../lib/change-count.ts';
import { cn } from '../lib/cn.ts';
import { Badge } from '../ui/badge.tsx';
import { buttonVariants } from '../ui/button-variants.ts';
import { Callout } from '../ui/callout.tsx';
import { Card, CardBody, CardHeader } from '../ui/card-base.tsx';
import { describeItem, type FieldLabels } from './describe.ts';
import { ReportRow } from './report-row.tsx';
import { WalletStatus } from './wallet-status.tsx';
import './wallet-report.css';

type Item = FidelityReportDto['items'][number];
export type ReportHost = 'author' | 'pane' | 'import' | 'review';

const C = WALLETS_COPY.report;
const COMPACT_ROWS = 3;

export const rowId = (i: Item) => `${i.capability}|${i.path}|${i.message}`;
const NONE: ReadonlySet<string> = new Set();

/** The status announced to a screen reader once edits settle (1 s). */
function useAnnounced(text: string): string {
  const [said, setSaid] = useState(text);
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), 1000);
    return () => clearTimeout(t);
  }, [text]);
  return said;
}

function Group({
  title,
  items,
  where,
  fresh,
  host,
  compact,
  action,
  menu,
}: {
  title: string;
  items: readonly Item[];
  where: (i: Item) => string;
  fresh: ReadonlySet<string>;
  host: ReportHost;
  compact: boolean;
  action: ((i: Item) => ReactNode) | undefined;
  menu: ((i: Item) => ReactNode) | undefined;
}) {
  const [all, setAll] = useState(false);
  const changes = useChangeCount(items.length);
  if (items.length === 0) return null;
  const shown = compact && !all ? items.slice(0, COMPACT_ROWS) : items;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-strong">
        {title}{' '}
        <span
          key={changes}
          className={cn('inline-block font-normal text-fg-muted', changes > 0 && 'wr-count')}
        >
          ({items.length})
        </span>
      </h3>
      <ul
        aria-label={title}
        className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface"
      >
        {shown.map((item) => (
          <ReportRow
            key={rowId(item)}
            item={item}
            where={where(item)}
            isNew={fresh.has(rowId(item))}
            review={host === 'review'}
            action={action?.(item)}
            menu={menu?.(item)}
          />
        ))}
      </ul>
      {compact && items.length > COMPACT_ROWS ? (
        <button
          type="button"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')}
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? 'Show fewer' : `Show ${items.length - COMPACT_ROWS} more`}
        </button>
      ) : null}
    </div>
  );
}

export interface WalletReportProps {
  report: FidelityReportDto;
  host: ReportHost;
  /** Field labels by path, from the view; without them a field reads as its key. */
  labels?: FieldLabels | undefined;
  /** The type line: `Loyalty · Automatic`. */
  typeLine?: ReactNode;
  /** Above the status: dry-run issues about the wallets block. */
  issues?: ReactNode;
  /** A line about the channel (off for this template). */
  note?: ReactNode;
  /** Review host: the approve checkbox in front of an omission. */
  itemAction?: ((item: Item) => ReactNode) | undefined;
  /** Author host: the row menu. */
  rowMenu?: ((item: Item) => ReactNode) | undefined;
  /** Author host: fixes under a Blocked reason. */
  blockedActions?: ReactNode;
  /** The buddy, seated on the card's top edge. */
  buddy?: ReactNode;
  /** A link out of the report: Edit in Wallets, Edit in designer. */
  footerAction?: ReactNode;
  busy?: boolean | undefined;
  /** Row ids new since the last render: they take the accent wash (useInsertHighlight). */
  fresh?: ReadonlySet<string> | undefined;
  /** Collapse long groups; a page with no script shows every row. */
  compact?: boolean | undefined;
  className?: string | undefined;
}

/**
 * One wallet's fidelity report: the status, what it drops and what it draws differently. The
 * designer, the Pass mode panes, the import report and the release review render this one
 * component; `host` decides which extras show.
 */
export function WalletReport({
  report,
  host,
  labels,
  typeLine,
  issues,
  note,
  itemAction,
  rowMenu,
  blockedActions,
  buddy,
  footerAction,
  busy,
  fresh = NONE,
  compact: collapse,
  className,
}: WalletReportProps) {
  const wallet = walletName(report.target);
  const { status } = report;
  const notShown = report.items.filter(
    (i) => i.severity === 'omission' && (i.group === 'holder' || i.group === 'door'),
  );
  const different = report.items.filter(
    (i) => i.severity === 'difference' || (i.severity === 'omission' && i.group === 'look'),
  );
  const absent = report.items.filter((i) => i.severity === 'omission' && i.group === 'absent');
  const said = useAnnounced(
    C.live.replace('{wallet}', wallet).replace('{status}', statusLabel(status)),
  );
  const where = (i: Item) => describeItem(i, labels);
  const compact = collapse ?? (host === 'pane' || host === 'import');
  const empty = status.kind === 'ready' && notShown.length + different.length + absent.length === 0;
  const group = (title: string, items: readonly Item[], withAction = false) => (
    <Group
      title={title}
      items={items}
      where={where}
      fresh={fresh}
      host={host}
      compact={compact}
      action={withAction ? itemAction : undefined}
      menu={rowMenu}
    />
  );
  return (
    <Card
      role="region"
      aria-label={`${wallet} report`}
      aria-busy={busy || undefined}
      data-testid={`${report.target}-report`}
      data-host={host}
      className={cn('wr', className)}
    >
      {buddy}
      <CardHeader title={wallet} as="h3" />
      <CardBody className="flex flex-col gap-4">
        {issues}
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <WalletStatus status={status} />
            {typeLine ? <span className="text-sm text-fg-muted">{typeLine}</span> : null}
          </div>
          {status.kind === 'omissions' && host !== 'review' ? (
            <p className="text-sm text-fg-muted">{C.approved}</p>
          ) : null}
        </div>
        {note ? <p className="text-sm text-fg-muted">{note}</p> : null}
        {status.kind === 'blocked' ? (
          <Callout
            tone="danger"
            title={C.blockedTitle.replace('{wallet}', wallet)}
            actions={host === 'author' ? blockedActions : undefined}
          >
            {status.reason}
          </Callout>
        ) : null}
        {group(C.notShown, notShown, true)}
        {group(C.different, different)}
        {absent.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-fg-strong">
              {C.notIn.replace('{wallet}', wallet)}
            </h3>
            <ul className="flex flex-wrap gap-1.5" aria-label={C.notIn.replace('{wallet}', wallet)}>
              {absent.map((i) => (
                <li key={rowId(i)}>
                  <Badge title={i.message}>{where(i)}</Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {empty ? <p className="text-sm text-fg-muted">{PREVIEW_COPY.allShown}</p> : null}
        <p className="text-xs text-fg-muted">{PREVIEW_COPY.sampleValues}</p>
        {footerAction}
      </CardBody>
      {host === 'author' ? (
        <p className="sr-only" role="status" aria-live="polite">
          {said}
        </p>
      ) : null}
    </Card>
  );
}
