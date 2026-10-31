import { Plus, Trash2 } from 'lucide-react';
import { Button, FormField, IconButton, Input, Select, Textarea } from '../../ui/index.ts';
import { blankRow, type MappingRow, TRANSFORMS, type TransformKind } from './mapping.ts';

export interface MappingEditorProps {
  rows: MappingRow[];
  onChange: (rows: MappingRow[]) => void;
  /** Template input keys, offered as suggestions. */
  inputKeys: string[];
  /** Connector output fields, offered as pointer suggestions. */
  outputKeys: string[];
  errors?: Record<string, string>;
  disabled?: boolean;
}

/** Template input ← upstream pointer + transform. */
export function MappingEditor({
  rows,
  onChange,
  inputKeys,
  outputKeys,
  errors = {},
  disabled,
}: MappingEditorProps) {
  const patch = (id: string, next: Partial<MappingRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...next } : r)));
  return (
    <div className="grid gap-4">
      <datalist id="mapping-inputs">
        {inputKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      <datalist id="mapping-outputs">
        {outputKeys.map((k) => (
          <option key={k} value={k} />
        ))}
      </datalist>
      {rows.length === 0 ? <p className="text-sm text-fg-muted">No mappings.</p> : null}
      {rows.map((row, i) => {
        const wantsOptions = TRANSFORMS.find((t) => t.value === row.kind)?.options;
        return (
          <fieldset
            key={row.id}
            className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-[1fr_1fr_11rem_auto]"
          >
            <legend className="px-1 text-xs text-fg-muted">Mapping {i + 1}</legend>
            <FormField label="Template input" error={errors[row.id]}>
              {(c) => (
                <Input
                  {...c}
                  list="mapping-inputs"
                  disabled={disabled}
                  value={row.input}
                  onChange={(e) => patch(row.id, { input: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Upstream pointer">
              {(c) => (
                <Input
                  {...c}
                  list="mapping-outputs"
                  disabled={disabled}
                  placeholder="/member/name"
                  value={row.from}
                  onChange={(e) => patch(row.id, { from: e.target.value })}
                />
              )}
            </FormField>
            <FormField label="Transform">
              {(c) => (
                <Select
                  {...c}
                  disabled={disabled}
                  value={row.kind}
                  onValueChange={(v) => patch(row.id, { kind: v as TransformKind | 'none' })}
                  options={TRANSFORMS.map((t) => ({ value: t.value, label: t.label }))}
                />
              )}
            </FormField>
            <div className="flex items-end">
              <IconButton
                label={`Remove mapping ${i + 1}`}
                icon={<Trash2 aria-hidden />}
                disabled={disabled}
                onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
              />
            </div>
            {wantsOptions ? (
              <FormField label="Options (JSON)" className="sm:col-span-4">
                {(c) => (
                  <Textarea
                    {...c}
                    rows={3}
                    className="font-mono text-xs"
                    disabled={disabled}
                    value={row.options}
                    onChange={(e) => patch(row.id, { options: e.target.value })}
                  />
                )}
              </FormField>
            ) : null}
          </fieldset>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          iconStart={<Plus aria-hidden />}
          disabled={disabled}
          onClick={() => onChange([...rows, blankRow()])}
        >
          Add mapping
        </Button>
      </div>
    </div>
  );
}
