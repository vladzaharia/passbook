import { ArrowRight, ChevronRight, KeyRound, Sparkles } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { MappingDateFormat } from '@/shared/contracts/issuing.ts';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import { cn } from '../../../lib/cn.ts';
import { Badge, Select } from '../../../ui/index.ts';
import { DATE_FORMATS, type MatchRow, type MatchState, SKIP, setColumns } from './match-model.ts';
import { shownSample } from './match-sample.ts';

const NONE = '__none__';
type Columns = PassImportDto['columns'];

const CONFIDENCE = {
  exact: { label: C.match.exact, tone: 'success' },
  similar: { label: C.match.similar, tone: 'info' },
  values: { label: C.match.fromValues, tone: 'accent' },
  join: { label: C.match.join, tone: 'neutral' },
} as const;

const chip = 'rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-fg';

function ColumnSelect({
  label,
  value,
  columns,
  onChange,
  disabled,
}: {
  label: string;
  value: string | undefined;
  columns: Columns;
  onChange: (pointer: string | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value ?? NONE}
      disabled={disabled}
      onValueChange={(v) => onChange(v === NONE ? undefined : v)}
      options={[
        { value: NONE, label: C.match.noColumn },
        ...columns.map((c) => ({ value: c.pointer, label: c.label })),
      ]}
    />
  );
}

/** Each distinct value of a choice column, with the option it becomes. */
export function ValueMap({
  row,
  canSkip,
  onChange,
}: {
  row: MatchRow;
  canSkip: boolean;
  onChange: (values: MatchRow['values']) => void;
}) {
  if (row.values.length === 0) return null;
  // Spellings that differ only in case or spacing are one choice: the most common one leads and
  // the rest are named under it.
  const groups = groupValues(row.values);
  return (
    <ul
      aria-label={C.match.valuesOf(row.label)}
      className="mt-3 flex flex-col gap-2 rounded-md bg-surface-sunken p-3"
    >
      {groups.map((g) => {
        const lead = g.members[0] as MatchRow['values'][number];
        const others = g.members.slice(1).map((m) => m.value);
        const to = g.members.every((m) => m.to === lead.to) ? lead.to : null;
        return (
          <li key={g.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <code
              className="w-28 shrink-0 truncate font-mono text-xs text-fg-strong"
              title={lead.value}
            >
              {lead.value}
            </code>
            <ArrowRight aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
            <Select
              aria-label={C.match.valueTo(lead.value)}
              className="w-44"
              placeholder={C.match.choose}
              value={to ?? undefined}
              onValueChange={(next) =>
                onChange(row.values.map((x) => (g.has(x.value) ? { ...x, to: next } : x)))
              }
              options={[
                ...row.options.map((o) => ({ value: o.value, label: o.label })),
                ...(canSkip ? [{ value: SKIP, label: C.match.dontIssue }] : []),
              ]}
            />
            {row.counted ? (
              <span className="text-xs text-fg-muted tabular-nums">
                {C.match.rowsCount(g.count)}
              </span>
            ) : null}
            {to === null ? <Badge tone="danger">{C.match.pickOne}</Badge> : null}
            {others.length > 0 ? (
              <span className="basis-full text-xs text-fg-muted">
                {C.match.alsoWritten(others)}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Values that differ only in case or surrounding spaces, most common first. */
function groupValues(values: MatchRow['values']) {
  const groups = new Map<string, MatchRow['values']>();
  for (const v of values) {
    const key = v.value.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  return [...groups].map(([key, members]) => {
    const spellings = new Set(members.map((m) => m.value));
    return {
      key,
      members,
      count: members.reduce((n, m) => n + m.count, 0),
      has: (value: string) => spellings.has(value),
    };
  });
}

function DateFormat({
  row,
  onChange,
}: {
  row: MatchRow;
  onChange: (format: MappingDateFormat) => void;
}) {
  const d = row.date;
  if (!d) return null;
  const clash = d.format === null && d.choices.length > 1;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-surface-sunken p-3 text-sm">
      <span className="text-fg-muted">{C.match.datesAs}</span>
      <Select
        aria-label={C.match.dateFormat(row.label)}
        className="w-44"
        placeholder={C.match.choose}
        value={d.format ?? undefined}
        onValueChange={(f) => onChange(f as MappingDateFormat)}
        options={DATE_FORMATS.filter((f) => !clash || d.choices.includes(f.value))}
      />
      {row.counted && d.format ? (
        <span className="text-xs text-fg-muted tabular-nums">
          {C.match.parse(d.parsed, d.total)}
        </span>
      ) : null}
      {clash ? <Badge tone="danger">{C.match.pickOne}</Badge> : null}
    </div>
  );
}

/** One template field: its type, the column that feeds it, a few cells as the pass will show them. */
export function MatchRowView({
  row,
  columns,
  state,
  error,
  index,
  onRow,
  canSkip = false,
}: {
  row: MatchRow;
  columns: Columns;
  state: MatchState;
  error?: string | undefined;
  index: number;
  onRow: (row: MatchRow) => void;
  /** Offer "Don't issue" as a value's target. */
  canSkip?: boolean;
}) {
  const matchBy = state.find === `col:${row.key}`;
  const first = columns.find((c) => c.pointer === row.from[0]);
  const samples = (first?.samples ?? [])
    .slice(0, 3)
    .map((cell, i) =>
      shownSample(row, cell, Object.fromEntries(columns.map((c) => [c.label, c.samples[i] ?? '']))),
    );
  const conf = row.confidence ? CONFIDENCE[row.confidence] : null;
  const set = (from: (string | undefined)[]) =>
    onRow(
      setColumns(
        row,
        from.filter((p): p is string => p !== undefined),
        columns,
      ),
    );
  return (
    <li
      style={{ '--i': index } as CSSProperties}
      className={cn(
        'border-b border-border px-4 py-4 last:border-b-0 sm:px-6',
        error && 'bg-danger-subtle',
      )}
    >
      <div className="grid items-start gap-x-4 gap-y-3 @[44rem]:grid-cols-[11rem_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-fg-strong">
            {row.label}
            {row.required ? <span aria-hidden> *</span> : null}
          </span>
          <Badge tone="neutral">{C.match.kind[row.kind]}</Badge>
          {matchBy ? (
            <Badge tone="warning">
              <KeyRound aria-hidden className="size-3" />
              {C.match.matchBy}
            </Badge>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <ColumnSelect
              label={C.match.columnFor(row.label)}
              value={row.from[0]}
              columns={columns}
              onChange={(p) => set([p, ...row.from.slice(1)])}
            />
          </div>
          {row.from.length > 1 ? (
            <>
              <span aria-hidden className="text-fg-muted">
                +
              </span>
              <div className="min-w-0 flex-1">
                <ColumnSelect
                  label={C.match.joinWith(row.label)}
                  value={row.from[1]}
                  columns={columns}
                  onChange={(p) => set([row.from[0], p])}
                />
              </div>
            </>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {samples.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cells of one row, fixed order, repeats allowed
            <span key={i} className={chip}>
              {s || C.match.empty}
            </span>
          ))}
          {conf ? (
            <Badge tone={conf.tone} className="ml-auto">
              {row.confidence === 'values' ? <Sparkles aria-hidden className="size-3" /> : null}
              {conf.label}
            </Badge>
          ) : null}
        </div>
      </div>
      {row.kind === 'choice' && row.from.length > 0 ? (
        <ValueMap row={row} canSkip={canSkip} onChange={(values) => onRow({ ...row, values })} />
      ) : null}
      {row.kind === 'date' && row.from.length > 0 ? (
        <DateFormat
          row={row}
          onChange={(format) => row.date && onRow({ ...row, date: { ...row.date, format } })}
        />
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** Fields with a column, then the optional ones with none, folded (a template can have dozens). */
export function MatchRows({
  rows,
  columns,
  state,
  errors,
  onRow,
}: {
  rows: readonly MatchRow[];
  columns: Columns;
  state: MatchState;
  errors: Record<string, string | undefined>;
  onRow: (row: MatchRow) => void;
}) {
  const empty = rows.filter((r) => r.from.length === 0 && !r.required);
  const fold = empty.length > 3;
  const open = fold ? rows.filter((r) => !empty.includes(r)) : rows;
  const view = (list: readonly MatchRow[]) =>
    list.map((row, i) => (
      <MatchRowView
        key={row.key}
        row={row}
        columns={columns}
        state={state}
        index={i}
        error={errors[row.key]}
        onRow={onRow}
      />
    ));
  return (
    <>
      <ul className="@container wl-stagger border-t border-border">{view(open)}</ul>
      {fold ? (
        <details
          className="group border-t border-border"
          open={empty.some((r) => errors[r.key]) || undefined}
        >
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-4 [&::-webkit-details-marker]:hidden text-sm font-medium text-fg-muted hover:text-fg-strong sm:px-6">
            <ChevronRight
              aria-hidden
              className="size-4 motion-safe:transition-transform group-open:rotate-90"
            />
            {C.match.emptyFields(empty.length)}
          </summary>
          <ul className="@container border-t border-border">{view(empty)}</ul>
        </details>
      ) : null}
    </>
  );
}
