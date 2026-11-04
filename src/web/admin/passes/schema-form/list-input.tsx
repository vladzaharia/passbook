import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../../lib/cn.ts';
import { Button, FormField, FormGrid, FormSpan, IconButton } from '../../../ui/index.ts';
import { Control, WIDE_WIDGETS } from './controls.tsx';
import { type FieldDef, type FormValues, rowErrorKey } from './schema.ts';

type Row = Record<string, unknown>;

export interface ListInputProps {
  field: FieldDef;
  value: unknown;
  onValue: (rows: Row[] | undefined) => void;
  /** Validation messages: the list's own, and `key.row.field` for rows. */
  errors: Record<string, string>;
  /** Messages from the server in the same shape. Always shown. */
  serverErrors?: Record<string, string> | undefined;
  showAllErrors?: boolean | undefined;
  disabled?: boolean | undefined;
  maxImageBytes: number;
  zone?: string | undefined;
}

let nextId = 0;
const newId = () => `r${++nextId}`;

/** What names a row to a reader: the first text it holds. */
function summary(rows: FieldDef[], row: Row): string {
  for (const f of rows) {
    const v = row[f.key];
    if (typeof v === 'string' && v.trim() && f.widget === 'text') return v.trim();
  }
  return '';
}

/**
 * Rows of fields for an array of objects. Add, remove and reorder by button; Alt with the up and
 * down arrow moves the row you are in. Each change is announced, and focus stays where it was.
 */
export function ListInput({
  field,
  value,
  onValue,
  errors,
  serverErrors,
  showAllErrors,
  disabled,
  maxImageBytes,
  zone,
}: ListInputProps) {
  const def = field.rows;
  const rows: Row[] = Array.isArray(value) ? (value as Row[]) : [];
  const titleId = useId();
  const helpId = useId();
  // Stable ids keep a row's DOM, focus and "touched" state with it through moves and removals.
  const [ids, setIds] = useState<string[]>(() => rows.map(newId));
  const [fresh, setFresh] = useState<string | null>(null);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [said, setSaid] = useState('');
  const refocus = useRef<(() => void) | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  let rowIds = ids;
  if (ids.length !== rows.length) {
    // The value changed from outside (reset, discard): keep the ids that still line up.
    rowIds = rows.map((_, i) => ids[i] ?? newId());
    setIds(rowIds);
  }
  useEffect(() => {
    refocus.current?.();
    refocus.current = null;
  });
  if (!def) return null;

  const emit = (next: Row[], nextIds: string[]) => {
    setIds(nextIds);
    onValue(next.length > 0 ? next : undefined);
  };
  const label = (i: number) => `${def.itemLabel} ${i + 1}`;
  const add = () => {
    if (rows.length >= def.max) return;
    const id = newId();
    setFresh(id);
    emit([...rows, {}], [...rowIds, id]);
    setSaid(`${def.itemLabel} ${rows.length + 1} added.`);
    refocus.current = () => {
      const first = rowRefs.current
        .get(id)
        ?.querySelector<HTMLElement>('input, select, textarea, button[role="combobox"]');
      first?.focus();
    };
  };
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    const nextIds = rowIds.filter((_, j) => j !== i);
    emit(next, nextIds);
    setSaid(`${label(i)} removed.`);
    // Land on the row that took its place, or the add button when none is left.
    const landing = nextIds[Math.min(i, nextIds.length - 1)];
    refocus.current = () =>
      (landing ? rowRefs.current.get(landing) : addRef.current)?.focus({ preventScroll: false });
  };
  const move = (i: number, by: -1 | 1) => {
    const to = i + by;
    if (to < 0 || to >= rows.length) return;
    const active = document.activeElement as HTMLElement | null;
    const next = [...rows];
    const nextIds = [...rowIds];
    for (const list of [next, nextIds] as unknown[][]) {
      const [item] = list.splice(i, 1);
      list.splice(to, 0, item);
    }
    emit(next, nextIds);
    setSaid(`${def.itemLabel} moved to position ${to + 1} of ${rows.length}.`);
    // A moved node can lose focus; put it back, or on the other arrow when this one just disabled.
    refocus.current = () => {
      const row = rowRefs.current.get(rowIds[i] as string);
      const edge = to === 0 || to === rows.length - 1;
      const other = row?.querySelector<HTMLElement>(`[data-move="${by === 1 ? 'up' : 'down'}"]`);
      const same = row?.querySelector<HTMLElement>(`[data-move="${by === 1 ? 'down' : 'up'}"]`);
      const target = active?.isConnected && !(active as HTMLButtonElement).disabled ? active : null;
      (target ?? (edge ? other : same))?.focus();
    };
  };
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || disabled) return;
    e.preventDefault();
    move(i, e.key === 'ArrowUp' ? -1 : 1);
  };
  const patch = (i: number, key: string, v: unknown) => {
    const next = rows.map((row, j) => {
      if (j !== i) return row;
      const copy: Row = { ...row };
      if (v === undefined || v === '') delete copy[key];
      else copy[key] = v;
      return copy;
    });
    emit(next, rowIds);
  };
  const touch = (id: string, key: string) =>
    setTouched((t) => (t.has(`${id}.${key}`) ? t : new Set(t).add(`${id}.${key}`)));

  const listError = serverErrors?.[field.key] ?? (showAllErrors ? errors[field.key] : undefined);
  const required = field.required;
  return (
    <fieldset
      className="min-w-0 border-0 p-0"
      aria-describedby={helpId}
      aria-invalid={listError ? true : undefined}
    >
      <legend id={titleId} className="mb-2 text-sm font-medium text-fg-strong">
        {field.label}
        {required ? (
          <span aria-hidden className="ml-0.5 text-danger">
            *
          </span>
        ) : null}
      </legend>
      <p
        id={helpId}
        className={cn('mb-3 max-w-[65ch] text-xs', listError ? 'text-danger' : 'text-fg-muted')}
      >
        {listError ??
          field.help ??
          `${rows.length} of ${def.max}. Alt with the arrow keys moves a row.`}
      </p>
      {rows.length > 0 ? (
        <ol className="mb-3 flex flex-col gap-3">
          {rows.map((row, i) => {
            const id = rowIds[i] as string;
            const name = summary(def.fields, row);
            return (
              <li
                key={id}
                ref={(el) => {
                  if (el) rowRefs.current.set(id, el);
                  else rowRefs.current.delete(id);
                }}
                tabIndex={-1}
                aria-labelledby={`${titleId}-${id}`}
                onKeyDown={(e) => onKeyDown(e, i)}
                data-fresh={fresh === id || undefined}
                className="min-w-0 rounded-md border border-border bg-surface-sunken p-3 outline-none focus-visible:outline-2 focus-visible:outline-focus motion-safe:data-fresh:animate-[wl-fade-in_var(--wl-dur-enter)_var(--wl-ease-out)_backwards] md:p-4"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <p
                    id={`${titleId}-${id}`}
                    className="min-w-0 truncate text-sm font-semibold text-fg-strong"
                  >
                    {label(i)}
                    {name ? <span className="font-normal text-fg-muted"> · {name}</span> : null}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      label={`Move ${label(i)} up`}
                      data-move="up"
                      size="sm"
                      icon={<ArrowUp aria-hidden />}
                      disabled={disabled || i === 0}
                      onClick={() => move(i, -1)}
                    />
                    <IconButton
                      label={`Move ${label(i)} down`}
                      data-move="down"
                      size="sm"
                      icon={<ArrowDown aria-hidden />}
                      disabled={disabled || i === rows.length - 1}
                      onClick={() => move(i, 1)}
                    />
                    <IconButton
                      label={`Remove ${label(i)}`}
                      size="sm"
                      icon={<Trash2 aria-hidden />}
                      disabled={disabled || rows.length <= def.min}
                      onClick={() => remove(i)}
                    />
                  </div>
                </div>
                {serverErrors?.[`${field.key}.${i}`] ? (
                  <p className="mb-3 text-xs text-danger">{serverErrors[`${field.key}.${i}`]}</p>
                ) : null}
                <FormGrid>
                  {def.fields.map((sub) => {
                    const key = rowErrorKey(field.key, i, sub.key);
                    const error =
                      serverErrors?.[key] ??
                      (showAllErrors || touched.has(`${id}.${sub.key}`) ? errors[key] : undefined);
                    return (
                      <FormSpan key={sub.key} full={WIDE_WIDGETS.has(sub.widget)}>
                        <FormField
                          label={sub.label}
                          help={sub.help}
                          error={error}
                          required={sub.required}
                        >
                          {(control) => (
                            <Control
                              field={sub}
                              value={row[sub.key]}
                              onValue={(v) => patch(i, sub.key, v)}
                              onBlur={() => touch(id, sub.key)}
                              control={control as unknown as Record<string, unknown>}
                              disabled={disabled}
                              maxImageBytes={maxImageBytes}
                              zone={zone}
                            />
                          )}
                        </FormField>
                      </FormSpan>
                    );
                  })}
                </FormGrid>
              </li>
            );
          })}
        </ol>
      ) : null}
      <Button
        ref={addRef}
        variant="outline"
        size="sm"
        iconStart={<Plus aria-hidden />}
        disabled={disabled || rows.length >= def.max}
        onClick={add}
      >
        {def.addLabel}
      </Button>
      <div role="status" aria-live="polite" className="sr-only">
        {said}
      </div>
    </fieldset>
  );
}

export type { FormValues };
