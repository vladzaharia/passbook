import { useId } from 'react';
import { FormField, Input, Select, type SelectOption } from '../../../ui/index.ts';
import type { Op } from './apply.ts';
import type { Source } from './bindings.ts';
import { useDesigner } from './context.tsx';
import { readInputs } from './inputs.ts';

/** A text control that edits through the history; quick keystrokes become one undo step. */
export function TextEdit({
  label,
  value,
  op,
  merge,
  help,
  error,
  placeholder,
  type = 'text',
  className,
  inputProps,
}: {
  label: string;
  value: string;
  /** Builds the op for the new text. */
  op: (text: string) => Op;
  merge: string;
  help?: string;
  error?: string;
  placeholder?: string;
  type?: string;
  className?: string;
  inputProps?: Record<string, string | number | undefined>;
}) {
  const { edit } = useDesigner();
  return (
    <FormField label={label} help={help} error={error} className={className}>
      {(control) => (
        <Input
          {...control}
          {...inputProps}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => edit(op(e.target.value), merge)}
        />
      )}
    </FormField>
  );
}

/** A native select for short fixed lists, edited through the history. */
export function PickEdit({
  label,
  value,
  options,
  onPick,
  help,
  className,
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onPick: (value: string) => void;
  help?: string;
  className?: string;
}) {
  return (
    <FormField label={label} help={help} className={className}>
      {(control) => (
        <Select
          id={control.id}
          aria-describedby={control['aria-describedby']}
          options={options}
          value={value}
          onValueChange={onPick}
        />
      )}
    </FormField>
  );
}

const STATIC = '__static';
const EXPR = '__expr';
const SCAN = '__scan';

/** Where a value comes from: typed in the template, one input or a custom expression. */
export function SourcePicker({
  label,
  source,
  onChange,
  scanCode = false,
  staticLabel = 'Text in the template',
  className,
}: {
  label: string;
  source: Source;
  onChange: (source: Source) => void;
  scanCode?: boolean;
  staticLabel?: string;
  className?: string;
}) {
  const { doc } = useDesigner();
  const inputs = readInputs(doc.manifest);
  const options: SelectOption[] = [
    { value: STATIC, label: staticLabel },
    ...inputs.map((i) => ({ value: `in:${i.name}`, label: `Input: ${i.label}` })),
    ...(scanCode ? [{ value: SCAN, label: 'Scan code of the pass' }] : []),
    ...(source.kind === 'expr' ? [{ value: EXPR, label: 'Custom expression' }] : []),
  ];
  const value =
    source.kind === 'input'
      ? `in:${source.name}`
      : source.kind === 'scanCode'
        ? SCAN
        : source.kind === 'expr'
          ? EXPR
          : STATIC;
  const known = options.some((o) => o.value === value);
  if (!known) options.push({ value, label: `Input: ${value.slice(3)} (missing)` });
  return (
    <PickEdit
      label={label}
      value={value}
      options={options}
      className={className}
      onPick={(v) => {
        if (v === STATIC) onChange({ kind: 'static' });
        else if (v === SCAN) onChange({ kind: 'scanCode' });
        else if (v === EXPR) return;
        else onChange({ kind: 'input', name: v.slice(3) });
      }}
    />
  );
}

/** A heading and a block of controls inside an inspector. */
export function Group({ title, children }: { title?: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} className="grid gap-3">
      {title ? (
        <h3 id={id} className="text-xs font-medium uppercase tracking-wide text-fg-muted">
          {title}
        </h3>
      ) : null}
      {children}
    </section>
  );
}
