import type { ScanRowDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { Button, FormField, NumberField, Select } from '../../../../ui/index.ts';
import { isRecord } from '../model.ts';
import type { Manifest, Pass } from './scan-fields.tsx';
import { safePreviewNumber, safePreviewText } from './scan-preview-policy.ts';

export type RowProps = {
  row: ScanRowDoc;
  manifest: Manifest;
  onChange: (row: ScanRowDoc, merge?: string) => void;
  role?: ScanRole;
  passJson?: Pass;
};
export const title = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const choices = (values: readonly string[]) =>
  values.map((value) => ({ value, label: title(value.replaceAll('_', ' ')) }));
export const TONES = choices(['neutral', 'teal', 'violet', 'gold']);
export const NOTE_TONES = choices(['neutral', 'info', 'attention']);
export const NONE = '__none';

export function Pick({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
}) {
  return (
    <FormField label={label}>
      {(control) => (
        <Select {...control} value={value} options={options} onValueChange={onChange} />
      )}
    </FormField>
  );
}

export function Numeric({
  label,
  value,
  onChange,
  mergeKey,
  min,
  max,
  integer = false,
  placeholder,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined, merge?: string) => void;
  mergeKey: string;
  min?: number;
  max?: number;
  integer?: boolean;
  placeholder?: string;
}) {
  if (typeof value === 'number' && !safePreviewNumber(String(value)))
    return (
      <div className="grid gap-2 text-sm text-fg-muted">
        <span>{label}: Sensitive value hidden and preserved.</span>
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          onClick={() => onChange(undefined)}
        >
          Replace {label}
        </Button>
      </div>
    );
  return (
    <FormField label={label}>
      {(control) => (
        <NumberField
          {...control}
          value={value}
          min={min}
          max={max}
          step={integer ? 1 : 'any'}
          placeholder={placeholder}
          onValueChange={(v) => {
            if (v === null) onChange(undefined, mergeKey);
            else if (
              Number.isFinite(v) &&
              safePreviewNumber(String(v)) &&
              (!integer || Number.isInteger(v)) &&
              (min === undefined || v >= min) &&
              (max === undefined || v <= max)
            )
              onChange(v, mergeKey);
          }}
        />
      )}
    </FormField>
  );
}

export const actionList = (
  manifest: Manifest,
): { id: string; label: string; kind: string; input?: string }[] => {
  const scan = isRecord(manifest.scan) ? manifest.scan : {};
  if (!Array.isArray(scan.actions)) return [];
  return scan.actions.flatMap((action) =>
    isRecord(action) && typeof action.id === 'string' && typeof action.kind === 'string'
      ? [
          {
            id: action.id,
            label:
              typeof action.label === 'string' && safePreviewText(action.label)
                ? action.label
                : 'Action',
            kind: action.kind,
            input: typeof action.input === 'string' ? action.input : undefined,
          },
        ]
      : [],
  );
};
