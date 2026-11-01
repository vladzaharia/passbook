import { ArrowRight, Plus, Trash2, WandSparkles } from 'lucide-react';
import { useState } from 'react';
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
}

const NONE = '__none__';
const GRID =
  '@[44rem]:grid-cols-[minmax(0,1fr)_1rem_minmax(0,1fr)_8.5rem_minmax(0,7rem)_2rem] @[44rem]:items-center';

function SourceBox({
  row,
  sources,
  disabled,
  invalid,
  onPick,
}: {
  row: MappingRow;
  sources: readonly SourceField[];
  disabled?: boolean | undefined;
  invalid?: boolean;
  onPick: (pointer: string) => void;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim();
  const known = sources.map((s) => s.pointer);
  const pool = [...known, ...(row.from && !known.includes(row.from) ? [row.from] : [])];
  const custom = q.startsWith('/') && !pool.includes(q) ? [q] : [];
  const options = [
    ...custom,
    ...pool.filter((p) => !q || p.toLowerCase().includes(q.toLowerCase())),
  ];
  return (
    <Combobox
      aria-label="Source field"
      aria-invalid={invalid}
      className="font-mono text-xs"
      disabled={disabled}
      value={row.from || undefined}
      placeholder="/field"
      searchPlaceholder="Field or /pointer"
      emptyText="Type a /pointer"
      onSearch={setQuery}
      onValueChange={onPick}
      options={options.map((p) => ({ value: p, label: p }))}
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
}: MappingEditorProps) {
  const patch = (id: string, next: Partial<MappingRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  const mapped = new Set(rows.map((r) => r.input.trim()));
  const missing = targets.filter((t) => t.required && !mapped.has(t.key));
  const labelOf = (key: string) => targets.find((t) => t.key === key)?.label ?? key;

  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      {missing.length && targets.length ? (
        <Callout
          tone="warning"
          title="Required fields without a source"
          items={missing.map((t) => t.label)}
        />
      ) : null}
      {rows.length === 0 ? (
        <EmptyState inline art="mapping" title="No mappings" className="py-4" />
      ) : (
        <div className="min-w-0">
          <div
            aria-hidden
            className={cn(
              'hidden gap-x-3 border-b border-border pb-2 text-xs font-medium text-fg-muted @[44rem]:grid',
              GRID,
            )}
          >
            <span>Source field</span>
            <span />
            <span>Template field</span>
            <span>Transform</span>
            <span>Sample value</span>
            <span />
          </div>
          <ul aria-label="Mappings" className="divide-y divide-border">
            {rows.map((row) => {
              const preview = previewValue(row, sources);
              const wantsOptions = TRANSFORMS.find((t) => t.value === row.kind)?.options;
              const summary = `${row.input ? labelOf(row.input) : 'Unmapped'} ← ${
                row.from ? leafOf(row.from) : 'no source'
              }${preview !== undefined ? ` = "${preview}"` : ''}`;
              return (
                <li
                  key={row.id}
                  data-row-id={row.id}
                  aria-label={summary}
                  className="grid grid-cols-1 gap-x-3 gap-y-2 py-3 last:pb-0 @[44rem]:grid-cols-1"
                >
                  <p className="truncate text-xs text-fg-muted @[44rem]:hidden">{summary}</p>
                  <div className={cn('grid gap-x-3 gap-y-2', GRID)}>
                    <SourceBox
                      row={row}
                      sources={sources}
                      disabled={disabled}
                      invalid={Boolean(errors[row.id] && !row.from)}
                      onPick={(from) => patch(row.id, { from })}
                    />
                    <ArrowRight
                      aria-hidden
                      className="hidden size-4 text-fg-subtle @[44rem]:block"
                    />
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
                    <Select
                      aria-label="Transform"
                      disabled={disabled}
                      value={row.kind}
                      onValueChange={(v) => patch(row.id, { kind: v as TransformKind | 'none' })}
                      options={TRANSFORMS.map((t) => ({ value: t.value, label: t.label }))}
                    />
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
                    <IconButton
                      label={`Remove ${row.input ? labelOf(row.input) : 'mapping'}`}
                      size="sm"
                      icon={<Trash2 aria-hidden />}
                      disabled={disabled}
                      onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                    />
                  </div>
                  {wantsOptions ? (
                    <Textarea
                      aria-label="Transform options (JSON)"
                      rows={2}
                      className="font-mono text-xs"
                      placeholder='{"map": {"gold": "Pro"}}'
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
          disabled={disabled || sources.length === 0 || targets.length === 0}
          onClick={() => onChange(autoMap(rows, targets, sources))}
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
