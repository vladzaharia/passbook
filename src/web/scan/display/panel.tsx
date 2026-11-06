import type { ReactNode } from 'react';
import type { ScanDisplayPanel, ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { ChipRow } from './chip.tsx';
import { scanIcon } from './icons.ts';
import { HistoryRow, ImageRow, ListRow } from './rows-list.tsx';
import { BigRow, ColumnsRow, DividerRow, FieldRow, HeadingRow, NoteRow } from './rows-text.tsx';
import { MoneyRow, ProgressRow } from './rows-value.tsx';

/** One row. An unknown type (a newer server) paints nothing: forward compatible. */
export function DisplayRowView({ row }: { row: ScanDisplayRow }): ReactNode {
  switch (row.type) {
    case 'heading':
      return <HeadingRow row={row} />;
    case 'field':
      return <FieldRow row={row} />;
    case 'big':
      return <BigRow row={row} />;
    case 'columns':
      return <ColumnsRow row={row} />;
    case 'progress':
      return <ProgressRow row={row} />;
    case 'money':
      return <MoneyRow row={row} />;
    case 'history':
      return <HistoryRow row={row} />;
    case 'image':
      return <ImageRow row={row} />;
    case 'chips':
      return <ChipRow chips={row.items} />;
    case 'list':
      return <ListRow row={row} />;
    case 'note':
      return <NoteRow row={row} />;
    case 'divider':
      return <DividerRow />;
    default:
      return null;
  }
}

/** The panel frame: header icon, label, rows. The width comes from the container, never from text. */
export function DisplayPanel({ panel }: { panel: ScanDisplayPanel }) {
  const Icon = scanIcon(panel.icon);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would add form semantics; a labelled section would be a landmark per panel
    <div
      role="group"
      className="sd-panel"
      data-kind={panel.kind}
      data-tone={panel.tone ?? undefined}
      aria-label={panel.title ?? undefined}
    >
      {panel.title || Icon ? (
        <header className="sd-panel-head" aria-hidden={panel.title ? undefined : true}>
          {Icon ? <Icon aria-hidden size={16} /> : null}
          {panel.title ? <span dir="auto">{panel.title}</span> : null}
        </header>
      ) : null}
      <div className="sd-rows">
        {panel.rows.map((row) => (
          <DisplayRowView key={row.id} row={row} />
        ))}
      </div>
    </div>
  );
}
