import { Clock, History as HistoryIcon } from 'lucide-react';
import type { ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { formatCount } from '../../lib/format.ts';
import { scanIcon } from './icons.ts';

type Row<T extends ScanDisplayRow['type']> = Extract<ScanDisplayRow, { type: T }>;

/** Past scans from server records: the ledger, visits or scans. Each row is at least 44 tall. */
export function HistoryRow({ row }: { row: Row<'history'> }) {
  if (row.items.length === 0) {
    return row.empty ? (
      <p className="sd-history-empty" dir="auto">
        {row.empty}
      </p>
    ) : null;
  }
  return (
    <ul className="sd-history">
      {row.items.map((item, i) => {
        const title = item.label ?? item.when ?? '—';
        const detail = [item.label ? item.when : null, item.where].filter(Boolean).join(' · ');
        const trailing =
          item.amount ??
          (item.delta === null
            ? null
            : `${item.delta > 0 ? '+' : '−'}${formatCount(Math.abs(item.delta))}`);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: history items have no ids; order is the identity
          <li key={i} className="sd-history-item">
            <span aria-hidden className="sd-history-disc">
              {item.elsewhere ? <Clock size={16} /> : <HistoryIcon size={16} />}
            </span>
            <span className="sd-history-text">
              <span className="sd-history-title" dir="auto">
                {title}
              </span>
              {detail ? (
                <span className="sd-history-detail" dir="auto">
                  {detail}
                </span>
              ) : null}
              {item.elsewhere ? (
                <span className="sd-history-detail">{SCAN_COPY.display.changedElsewhere}</span>
              ) : null}
            </span>
            {trailing ? <span className="sd-history-amount">{trailing}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** A thumbnail is a media row; a strip is a 3:1 banner. No url: the title and detail alone. */
export function ImageRow({ row }: { row: Row<'image'> }) {
  const img = row.url ? (
    <img
      className="sd-image-img"
      src={row.url}
      alt={row.alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  ) : null;
  const text =
    row.title || row.detail ? (
      <span className="sd-image-text">
        {row.title ? (
          <span className="sd-image-title" dir="auto">
            {row.title}
          </span>
        ) : null}
        {row.detail ? (
          <span className="sd-image-detail" dir="auto">
            {row.detail}
          </span>
        ) : null}
      </span>
    ) : null;
  if (!img && !text) return null;
  return (
    <div className="sd-image" data-source={row.source}>
      {img}
      {text}
    </div>
  );
}

/** Icon rows (perks, zones). `pair` puts two on a line when the server says it fits, or at the wide width. */
export function ListRow({ row }: { row: Row<'list'> }) {
  return (
    <ul
      className="sd-list"
      data-pair={row.pair ? '' : undefined}
      data-one-line={row.oneLine ? 'true' : 'false'}
    >
      {row.items.map((item) => {
        const Icon = scanIcon(item.icon);
        return (
          <li key={item.id} className="sd-list-item">
            {Icon ? <Icon aria-hidden size={20} className="sd-list-icon" /> : null}
            <span className="sd-list-text">
              <span dir="auto">{item.text}</span>
              {item.detail ? (
                <span className="sd-list-detail" dir="auto">
                  {item.detail}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
