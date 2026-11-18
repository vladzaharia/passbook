import { ArrowRight, Plus, Trash2, WandSparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../../lib/cn.ts';
import {
  Button,
  Callout,
  Combobox,
  EmptyState,
  IconButton,
  Select,
  Textarea,
} from '../../ui/index.ts';
import {
  autoMap,
  blankRow,
  leafOf,
  type MappingRow,
  OPTIONS_HINT,
  previewValue,
  type SourceField,
  type TargetField,
  TRANSFORMS,
  type TransformKind,
} from './mapping.ts';

export interface MappingEditorProps {
  rows: MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  /** Template inputs: the targets. */
  targets: readonly TargetField[];
  /** Pointers from the last test sample, else the connector's output fields. */
  sources: readonly SourceField[];
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Left-column heading and control name: "Column" for a file, "Source field" by default. */
  sourceNoun?: string;
  /** Fixed targets shown first, one row each; they cannot be re-targeted or removed. */
  pinned?: readonly TargetField[];
}

const NONE = '__none__';
const GRID =
  '@[36rem]:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)_8.5rem_minmax(0,7rem)_2rem] @[36rem]:items-center';

/** Below 36rem each control gets a visible caption; the wide grid has one header row instead. */
function Stacked({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 @[36rem]:contents">
      <span aria-hidden className="text-xs text-fg-muted @[36rem]:hidden">
        {caption}
      </span>
      {children}
    </div>
  );
}

function SourceBox({
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

/** Source field → template field, with a transform and the live sample value per row. */
export function MappingEditor({
  rows,
  onChange,
  targets,
  sources,
  errors = {},
  disabled,
  sourceNoun = 'Source field',
  pinned = [],
}: MappingEditorProps) {
  const patch = (id: string, next: Partial<MappingRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  const mapped = new Set(rows.filter((r) => r.from.trim()).map((r) => r.input.trim()));
  const all = [...pinned, ...targets];
  const missing = all.filter((t) => t.required && !mapped.has(t.key));
  const labelOf = (key: string) => all.find((t) => t.key === key)?.label ?? key;
  const pinnedKeys = new Set(pinned.map((p) => p.key));
  const ordered = [
    ...pinned.flatMap((p) => rows.filter((r) => r.input === p.key)),
    ...rows.filter((r) => !pinnedKeys.has(r.input)),
  ];

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      {missing.length && all.length ? (
        <Callout
          tone="warning"
          title="Required fields without a source"
          items={missing.map((t) => t.label)}
        />
      ) : null}
      {ordered.length === 0 ? (
        <EmptyState inline art="mapping" title="No mappings" className="py-4" />
      ) : (
        <div className="min-w-0">
          <div
            aria-hidden
            className={cn(
              'hidden gap-x-3 border-b border-border pb-2 text-xs font-medium text-fg-muted @[36rem]:grid',
              GRID,
            )}
          >
            <span>{sourceNoun}</span>
            <span />
            <span>Template field</span>
            <span>Transform</span>
            <span>Sample value</span>
            <span />
          </div>
          <ul aria-label="Mappings" className="divide-y divide-border">
            {ordered.map((row) => {
              const preview = previewValue(row, sources);
              const wantsOptions = TRANSFORMS.find((t) => t.value === row.kind)?.options;
              const isPinned = pinnedKeys.has(row.input);
              const source = sources.find((s) => s.pointer === row.from);
              const summary = `${row.input ? labelOf(row.input) : 'Unmapped'} ← ${
                row.from ? (source?.label ?? leafOf(row.from)) : 'no source'
              }${preview !== undefined ? ` = "${preview}"` : ''}`;
              return (
                <li
                  key={row.id}
                  data-row-id={row.id}
                  aria-label={summary}
                  className="grid grid-cols-1 gap-x-3 gap-y-2 py-3 last:pb-0 @[36rem]:grid-cols-1"
                >
                  <p className="truncate text-xs text-fg-muted @[36rem]:hidden">{summary}</p>
                  <div className={cn('grid gap-x-3 gap-y-2', GRID)}>
                    <Stacked caption={sourceNoun}>
                      <SourceBox
                        row={row}
                        sources={sources}
                        noun={sourceNoun}
                        disabled={disabled}
                        invalid={Boolean(errors[row.id] && !row.from)}
                        onPick={(from) => patch(row.id, { from })}
                      />
                    </Stacked>
                    <ArrowRight
                      aria-hidden
                      className="hidden size-4 text-fg-subtle @[36rem]:block"
                    />
                    <Stacked caption="Template field">
                      {isPinned ? (
                        <span className="min-w-0 truncate text-sm font-medium">
                          {labelOf(row.input)}
                          {all.find((t) => t.key === row.input)?.required ? ' *' : ''}
                        </span>
                      ) : (
                        <Select
                          aria-label="Template field"
                          disabled={disabled}
                          value={row.input || NONE}
                          onValueChange={(v) => patch(row.id, { input: v === NONE ? '' : v })}
                          options={[
                            { value: NONE, label: 'Choose a field' },
                            ...targets.map((t) => ({
                              value: t.key,
                              label: t.required ? `${t.label} *` : t.label,
                            })),
                            ...(row.input && !targets.some((t) => t.key === row.input)
                              ? [{ value: row.input, label: row.input }]
                              : []),
                          ]}
                        />
                      )}
                    </Stacked>
                    <Stacked caption="Transform">
                      <Select
                        aria-label="Transform"
                        disabled={disabled}
                        value={row.kind}
                        onValueChange={(v) => patch(row.id, { kind: v as TransformKind | 'none' })}
                        options={TRANSFORMS.map((t) => ({ value: t.value, label: t.label }))}
                      />
                    </Stacked>
                    {/* Stacked, the sample and Remove share one trailing row. */}
                    <div className="flex min-w-0 items-center justify-between gap-2 @[36rem]:contents">
                      <output
                        aria-label="Sample value"
                        className="min-w-0 truncate text-sm text-fg"
                        title={preview}
                      >
                        {preview === undefined ? (
                          <span className="text-fg-subtle">—</span>
                        ) : (
                          `“${preview}”`
                        )}
                      </output>
                      {isPinned ? (
                        <span />
                      ) : (
                        <IconButton
                          label={`Remove ${row.input ? labelOf(row.input) : 'mapping'}`}
                          size="sm"
                          icon={<Trash2 aria-hidden />}
                          disabled={disabled}
                          onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                        />
                      )}
                    </div>
                  </div>
                  {wantsOptions ? (
                    <Textarea
                      aria-label="Transform options (JSON)"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder={OPTIONS_HINT[row.kind as TransformKind]}
                      disabled={disabled}
                      value={row.options}
                      onChange={(e) => patch(row.id, { options: e.target.value })}
                    />
                  ) : null}
                  {errors[row.id] ? <p className="text-xs text-danger">{errors[row.id]}</p> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <Button
          variant="outline"
          size="sm"
          iconStart={<Plus aria-hidden />}
          disabled={disabled}
          onClick={() => onChange([...rows, blankRow()])}
        >
          Add mapping
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconStart={<WandSparkles aria-hidden />}
          disabled={disabled || sources.length === 0 || all.length === 0}
          onClick={() => onChange(autoMap(rows, all, sources))}
        >
          Auto-map by name
        </Button>
      </div>
    </div>
  );
}

/** Template input fields as mapping targets. */
export function targetsOf(
  fields: readonly {
    key: string;
    label: string;
    required: boolean;
    options?: { value: string }[] | undefined;
  }[],
): TargetField[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    required: f.required,
    values: f.options?.map((o) => o.value),
  }));
}
