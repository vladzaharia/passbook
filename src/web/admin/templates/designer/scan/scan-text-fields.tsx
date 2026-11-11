import type { ScanText } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { SwitchRow } from '../../../../ui/index.ts';
import { type Manifest, type Pass, scanBindingOptions } from './scan-fields.tsx';
import { StringField } from './scan-string-field.tsx';

type TextFieldProps = {
  label: string;
  value: ScanText | null | undefined;
  manifest: Manifest;
  onChange: (value: ScanText | undefined, merge?: string) => void;
  mergeKey: string;
  audienceRole?: ScanRole;
  optional?: boolean;
  allowedPaths?: readonly string[];
  passJson?: Pass;
  allowFormats?: boolean;
};

export function ScanTextField({
  label,
  value,
  manifest,
  onChange,
  mergeKey,
  audienceRole = 'door',
  optional = false,
  allowedPaths,
  passJson,
  allowFormats = true,
}: TextFieldProps) {
  const options = scanBindingOptions(manifest, audienceRole, passJson, allowedPaths);
  const plural =
    value !== null &&
    typeof value === 'object' &&
    typeof value.count === 'string' &&
    typeof value.one === 'string' &&
    typeof value.other === 'string'
      ? value
      : null;
  const simple = typeof value === 'string' ? value : '';
  return (
    <div className="grid gap-3">
      {plural ? (
        <>
          <StringField
            label={`${label} count`}
            value={plural.count}
            options={options}
            allowFormats={allowFormats}
            mergeKey={`${mergeKey}:count`}
            onChange={(v, merge) => onChange({ ...plural, count: v }, merge)}
          />
          <StringField
            label={`${label} singular`}
            value={plural.one}
            options={options}
            allowFormats={allowFormats}
            mergeKey={`${mergeKey}:one`}
            onChange={(v, merge) => onChange({ ...plural, one: v }, merge)}
          />
          <StringField
            label={`${label} plural`}
            value={plural.other}
            options={options}
            allowFormats={allowFormats}
            mergeKey={`${mergeKey}:other`}
            onChange={(v, merge) => onChange({ ...plural, other: v }, merge)}
          />
          <StringField
            label={`${label} zero`}
            value={typeof plural.zero === 'string' ? plural.zero : ''}
            options={options}
            allowFormats={allowFormats}
            mergeKey={`${mergeKey}:zero`}
            onChange={(v, merge) => onChange({ ...plural, zero: v || undefined }, merge)}
          />
        </>
      ) : (
        <StringField
          label={label}
          value={simple}
          options={options}
          allowFormats={allowFormats}
          mergeKey={mergeKey}
          onChange={(v, merge) => onChange(optional && v === '' ? undefined : v, merge)}
        />
      )}
      <SwitchRow
        label={`Use plural forms for ${label}`}
        checked={plural !== null}
        onCheckedChange={(on) =>
          onChange(on ? { count: '', one: simple, other: simple } : (plural?.other ?? ''))
        }
      />
    </div>
  );
}

export function ScanExpressionField({
  label,
  value,
  manifest,
  onChange,
  mergeKey,
  role = 'door',
  optional = false,
  allowedPaths,
  passJson,
}: {
  label: string;
  value: string | undefined;
  manifest: Manifest;
  onChange: (value: string | undefined, merge?: string) => void;
  mergeKey: string;
  role?: ScanRole;
  optional?: boolean;
  allowedPaths?: readonly string[];
  passJson?: Pass;
}) {
  return (
    <StringField
      label={label}
      value={typeof value === 'string' ? value : ''}
      options={scanBindingOptions(manifest, role, passJson, allowedPaths)}
      mergeKey={mergeKey}
      expressionOnly
      onChange={(v, merge) => onChange(optional && v === '' ? undefined : v, merge)}
    />
  );
}
