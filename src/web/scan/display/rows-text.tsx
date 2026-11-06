import type { CSSProperties } from 'react';
import type { ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { scanIcon } from './icons.ts';

type Row<T extends ScanDisplayRow['type']> = Extract<ScanDisplayRow, { type: T }>;

/** Every text is a text node with `dir="auto"`: a template can never inject markup or force a direction. */
export function HeadingRow({ row }: { row: Row<'heading'> }) {
  return (
    <div className="sd-heading">
      <span dir="auto">{row.text}</span>
      {row.detail ? <span dir="auto">{row.detail}</span> : null}
    </div>
  );
}

const LONG_VALUE = 24;

export function FieldRow({ row }: { row: Row<'field'> }) {
  const Icon = scanIcon(row.icon);
  return (
    <div
      className="sd-field"
      data-strong={row.strong ? '' : undefined}
      data-long={Array.from(row.value).length > LONG_VALUE ? '' : undefined}
    >
      <span className="sd-field-label">
        {Icon ? <Icon aria-hidden size={18} /> : null}
        <span dir="auto">{row.label}</span>
      </span>
      <span className="sd-field-value" dir="auto">
        {row.value}
      </span>
    </div>
  );
}

export function BigRow({ row }: { row: Row<'big'> }) {
  return (
    <div className="sd-big" data-tone={row.tone ?? undefined}>
      {row.label ? (
        <span className="sd-big-label" dir="auto">
          {row.label}
        </span>
      ) : null}
      <span className="sd-big-line">
        <span className="sd-big-value" dir="auto">
          {row.value}
        </span>
        {row.unit ? (
          <span className="sd-big-unit" dir="auto">
            {row.unit}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** `oneLine` is the server's compact-width verdict; CSS applies it under 400 px and ignores it above. */
export function ColumnsRow({ row }: { row: Row<'columns'> }) {
  return (
    <div
      className="sd-cols"
      data-size={row.size}
      data-one-line={row.oneLine ? 'true' : 'false'}
      style={{ '--n': row.items.length } as CSSProperties}
    >
      {row.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: columns have no ids; order is the identity
        <div key={i} className="sd-col">
          <span className="sd-col-label" dir="auto">
            {item.label}
          </span>
          <span className="sd-col-value" dir="auto">
            {item.value === '' ? '—' : item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function NoteRow({ row }: { row: Row<'note'> }) {
  const Icon = scanIcon(row.icon);
  return (
    <div className="sd-note" data-tone={row.tone}>
      {Icon ? <Icon aria-hidden size={18} /> : null}
      <span dir="auto">{row.text}</span>
    </div>
  );
}

export function DividerRow() {
  return <hr className="sd-divider" />;
}
