import { Gift, Plus, Stamp as StampIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { cn } from '../../lib/cn.ts';
import { formatCount, formatMoney } from '../../lib/format.ts';
import { scanIcon } from './icons.ts';

type Row<T extends ScanDisplayRow['type']> = Extract<ScanDisplayRow, { type: T }>;

/** Stamps up to 10; a longer goal always paints as a bar (the server refuses stamps over 10). */
const MAX_STAMPS = 10;

function Caption({ text, gift }: { text: string; gift: boolean }) {
  // The first number in the system caption is the one that matters: "2 more for Free coffee".
  const m = /\d+/.exec(text);
  return (
    <p className="sd-caption" dir="auto">
      {gift ? <Gift aria-hidden size={18} className="sd-caption-gift" /> : null}
      <span>
        {m ? text.slice(0, m.index) : text}
        {m ? <b>{m[0]}</b> : null}
        {m ? text.slice(m.index + m[0].length) : null}
      </span>
    </p>
  );
}

export function ProgressRow({ row }: { row: Row<'progress'> }) {
  const stamps = row.style === 'stamps' && row.goal <= MAX_STAMPS;
  const Icon = scanIcon(row.icon) ?? StampIcon;
  const value = Math.max(0, Math.min(row.value, row.goal));
  const before = row.before === null ? null : Math.max(0, Math.min(row.before, row.goal));
  const moved = before !== null && before !== value;
  const pct = (n: number) => `${(n / row.goal) * 100}%`;
  return (
    <div className="sd-progress">
      <p className="sd-readout">
        {moved ? (
          <>
            <span className="sd-readout-from">{formatCount(before)}</span>
            <span aria-hidden className="sd-arrow">
              {'→'}
            </span>
            <span className="sr-only">to</span>
          </>
        ) : null}
        <span className="sd-readout-now">{formatCount(row.value)}</span>
        <span className="sd-readout-of">
          of {formatCount(row.goal)}
          {stamps ? ' stamps' : ''}
        </span>
      </p>
      {stamps ? (
        <div className="sd-stamps" aria-hidden style={{ '--goal': row.goal } as CSSProperties}>
          {Array.from({ length: row.goal }, (_, i) => {
            const filled = i < value;
            const fresh = filled && before !== null && i >= before;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: a stamp is its position
                key={i}
                className={cn('sd-stamp', filled && 'is-filled', fresh && 'is-new')}
                style={{ '--i': i - (before ?? 0) } as CSSProperties}
              >
                {filled ? <Icon size={20} strokeWidth={2.25} /> : null}
                {fresh ? (
                  <span className="sd-stamp-badge">
                    <Plus size={11} strokeWidth={3.5} />
                  </span>
                ) : null}
              </span>
            );
          })}
        </div>
      ) : (
        <div className="sd-bar" aria-hidden>
          <span
            className="sd-bar-fill"
            data-moved={moved ? '' : undefined}
            style={
              {
                '--to': pct(value),
                '--from': pct(before ?? value),
              } as CSSProperties
            }
          />
        </div>
      )}
      {row.caption ? <Caption text={row.caption} gift={row.rewards >= 1} /> : null}
    </div>
  );
}

export function MoneyRow({ row }: { row: Row<'money'> }) {
  const changed = row.before !== null && row.before !== row.amount;
  return (
    <div className="sd-money">
      {row.label ? (
        <span className="sd-big-label" dir="auto">
          {row.label}
        </span>
      ) : null}
      <div className="sd-money-line">
        {changed && row.before !== null ? (
          <>
            <s className="sd-money-old">{formatMoney(row.before, row.currency)}</s>
            <span aria-hidden className="sd-arrow">
              {'→'}
            </span>
            <span className="sr-only">to</span>
          </>
        ) : null}
        <span className="sd-money-new" dir="auto">
          {row.text}
        </span>
        {row.change !== null && row.change !== 0 ? (
          <span className="sd-money-change">{formatMoney(row.change, row.currency, true)}</span>
        ) : null}
      </div>
      {row.low ? <p className="sd-low">{SCAN_COPY.display.lowBalance}</p> : null}
    </div>
  );
}
