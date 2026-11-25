import type { z } from 'zod';
import type { ConnectionFileSchema } from '@/shared/contracts/connection-files.ts';
import { formatCount, pluralize } from '../../../lib/format.ts';
import { StepList, type StepListItem } from '../../../ui/index.ts';

type Parsed = z.infer<typeof ConnectionFileSchema>;

/** What the parser and the chosen ID column say about the file, row by row. */
export function checksOf(file: Parsed, idColumn: string): StepListItem[] {
  const col = file.columns.find((c) => c.pointer === idColumn);
  const skipped = col ? col.blanks + col.duplicates : 0;
  const none = file.rows > 0 && skipped >= file.rows;
  const items: StepListItem[] = [
    {
      id: 'read',
      state: file.rows > 0 ? 'done' : 'failed',
      label: file.rows > 0 ? `${pluralize(file.rows, 'row')} read` : 'No rows found',
      detail: `${pluralize(file.columns.length, 'column')} · ${file.format.toUpperCase()}`,
    },
  ];
  if (file.sheet)
    items.push({ id: 'sheet', state: 'done', label: `Sheet ${file.sheet}`, detail: undefined });
  if (!col) {
    items.push({ id: 'id', state: 'invalid', label: 'Pick the ID column' });
  } else if (none) {
    items.push({
      id: 'id',
      state: 'failed',
      label: 'No row has a usable ID',
      detail: 'Pick another column.',
    });
  } else if (skipped > 0) {
    const parts = [
      col.blanks > 0 ? `${formatCount(col.blanks)} with no ID` : '',
      col.duplicates > 0 ? `${formatCount(col.duplicates)} repeating one` : '',
    ].filter(Boolean);
    items.push({
      id: 'id',
      state: 'invalid',
      label: `${pluralize(skipped, 'row')} skipped`,
      detail: parts.join(', '),
    });
  } else {
    items.push({ id: 'id', state: 'done', label: 'Every row has a unique ID', detail: col.label });
  }
  return items;
}

export function FileChecks({ file, idColumn }: { file: Parsed; idColumn: string }) {
  return <StepList label="File checks" items={checksOf(file, idColumn)} />;
}
