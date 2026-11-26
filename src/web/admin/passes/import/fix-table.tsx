import { Download, Pencil } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, useState } from 'react';
import type { PassImportDto } from '@/shared/contracts/pass-imports.ts';
import { IMPORT_COPY as C } from '@/shared/copy/imports.ts';
import type { InputField } from '@/shared/issuing/fields.ts';
import { Badge, Button, Input, Select } from '../../../ui/index.ts';

type Problem = PassImportDto['problems'][number];

function FixCell({
  field,
  busy,
  onSave,
  onCancel,
  label,
  start,
}: {
  field: InputField | undefined;
  busy: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
  label: string;
  start: string;
}) {
  const [value, setValue] = useState(start);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && value.trim()) onSave(value.trim());
  };
  if (field?.options)
    return (
      <Select
        aria-label={label}
        className="w-40"
        placeholder={C.match.choose}
        value={undefined}
        disabled={busy}
        onValueChange={(v) => onSave(field.options?.find((o) => o.value === v)?.label ?? v)}
        options={field.options.map((o) => ({ value: o.value, label: o.label }))}
      />
    );
  return (
    <Input
      autoFocus
      aria-label={label}
      className="w-44"
      value={value}
      disabled={busy}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={key}
      onBlur={() => !value.trim() && onCancel()}
    />
  );
}

/**
 * Rows the check refused, with the fix in place: pick or type the value and press Enter. The fix
 * is kept in the plan, so the file is not changed and the check runs again.
 */
export function FixTable({
  imp,
  fields,
  editable,
  total,
  busy,
  title,
  onFix,
  onDownload,
}: {
  imp: PassImportDto;
  fields: ReadonlyMap<string, InputField>;
  editable: boolean;
  /** Rows to fix, or notes: the tile's number. */
  total: number;
  busy: boolean;
  title: string;
  onFix?: (row: number, pointer: string, value: string) => void;
  onDownload?: (() => void) | undefined;
}) {
  const [editing, setEditing] = useState<string>();
  const shown = imp.problems.filter((p) => (p.severity === 'error') === editable);
  if (shown.length === 0) return null;
  // Two problems of one cell (a format and a pattern) share row, code and column: the position tells them apart.
  const idOf = (p: Problem, i: number) => `${i}:${p.row}:${p.code}:${p.column ?? ''}`;
  return (
    <section aria-label={title} className="rounded-lg border border-border bg-surface-raised">
      <div className="flex min-h-12 flex-wrap items-center justify-between gap-x-3 border-b border-border px-4">
        <h3 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-fg-strong">
          {title}
          <Badge tone={editable ? 'danger' : 'warning'}>{total}</Badge>
        </h3>
        {onDownload ? (
          <Button
            variant="ghost"
            size="sm"
            iconStart={<Download aria-hidden />}
            onClick={onDownload}
          >
            {C.check.download}
          </Button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm sm:min-w-[28rem]">
          <caption className="sr-only">{editable ? C.check.errors : C.check.notes}</caption>
          <thead className="text-xs text-fg-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                {C.results.row}
              </th>
              <th scope="col" className="px-3 py-2 font-medium max-sm:hidden">
                {C.results.column}
              </th>
              {editable ? (
                <th scope="col" className="px-3 py-2 font-medium max-sm:hidden">
                  {C.check.value}
                </th>
              ) : null}
              <th scope="col" className="px-3 py-2 font-medium">
                {C.results.problem}
              </th>
              {editable ? (
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">{C.check.fix}</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="wl-stagger divide-y divide-border border-t border-border">
            {shown.map((p, i) => {
              const id = idOf(p, i);
              const pointer = imp.columns.find((c) => c.label === p.column)?.pointer;
              return (
                <tr key={id} style={{ '--i': i } as CSSProperties}>
                  <td className="px-4 py-3 tabular-nums text-fg-strong">{p.row}</td>
                  <td className="px-3 py-3 text-fg-muted max-sm:hidden">{p.column ?? ''}</td>
                  {editable ? (
                    <td className="px-3 py-3 max-sm:hidden">
                      {p.value ? (
                        <code className="whitespace-nowrap rounded bg-danger-subtle px-1.5 font-mono text-xs text-danger">
                          {p.value}
                        </code>
                      ) : null}
                    </td>
                  ) : null}
                  <td
                    className="px-3 py-3 break-words text-danger data-[note]:text-fg"
                    data-note={editable ? undefined : ''}
                  >
                    {p.message}
                  </td>
                  {editable ? (
                    <td className="px-3 py-3 text-right">
                      {pointer && onFix ? (
                        editing === id ? (
                          <FixCell
                            field={p.field ? fields.get(p.field) : undefined}
                            busy={busy}
                            label={C.check.fixCell(p.row, p.column ?? '')}
                            start={p.value ?? ''}
                            onCancel={() => setEditing(undefined)}
                            onSave={(v) => {
                              onFix(p.row, pointer, v);
                              setEditing(undefined);
                            }}
                          />
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            iconStart={<Pencil aria-hidden />}
                            aria-label={C.check.fixCell(p.row, p.column ?? '')}
                            onClick={() => setEditing(id)}
                          >
                            {C.check.fix}
                          </Button>
                        )
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {imp.problemsTruncated ? (
        <p className="border-t border-border px-4 py-2 text-xs text-fg-muted">
          {C.check.truncated(
            imp.problems.length,
            imp.problemTotals.errors + imp.problemTotals.warnings,
          )}
        </p>
      ) : null}
    </section>
  );
}
