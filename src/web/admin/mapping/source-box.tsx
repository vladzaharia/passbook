import { useState } from 'react';
import { Combobox } from '../../ui/index.ts';
import type { MappingRow, SourceField } from './mapping.ts';

/** The source side of a mapping row: a column or /pointer picker. */
export function SourceBox({
  row,
  sources,
  noun,
  disabled,
  invalid,
  onPick,
}: {
  row: MappingRow;
  sources: readonly SourceField[];
  noun: string;
  disabled?: boolean | undefined;
  invalid?: boolean;
  onPick: (pointer: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const known = sources.map((s) => ({ value: s.pointer, label: s.label ?? s.pointer }));
  const pool = [
    ...known,
    ...(row.from && !known.some((k) => k.value === row.from)
      ? [{ value: row.from, label: row.from }]
      : []),
  ];
  const custom =
    q.startsWith('/') && !pool.some((p) => p.value === q) ? [{ value: q, label: q }] : [];
  const needle = q.toLowerCase();
  const options = [
    ...custom,
    ...pool.filter(
      (p) => !q || p.label.toLowerCase().includes(needle) || p.value.toLowerCase().includes(needle),
    ),
  ];
  const labelled = sources.some((s) => s.label !== undefined);
  return (
    <Combobox
      aria-label={noun}
      aria-invalid={invalid}
      className={labelled ? 'text-sm' : 'font-mono text-xs'}
      disabled={disabled}
      value={row.from || undefined}
      placeholder={labelled ? 'Choose a column' : '/field'}
      searchPlaceholder={labelled ? noun : `${noun} or /pointer`}
      emptyText={labelled ? 'No match' : 'Type a /pointer'}
      onSearch={setQuery}
      onValueChange={onPick}
      options={options}
    />
  );
}
