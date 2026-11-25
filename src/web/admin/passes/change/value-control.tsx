import { DateTimeField, Input, NumberField, Select } from '../../../ui/index.ts';
import { isoToLocal, localToIso } from '../schema-form/datetime.ts';
import type { FieldDef } from '../schema-form/index.ts';

/** Widgets a run can set from one control; the rest (images, lists, access) stay on the pass. */
export const SETTABLE = new Set([
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'date',
  'datetime',
  'url',
  'email',
]);

/** The value a `set` takes, as the field's own control: choice, yes/no, number, date or text. */
export function ValueControl({
  field,
  value,
  onChange,
  control,
  timeZone,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (value: unknown) => void;
  /** The org's zone: a date-time reads and saves in it. */
  timeZone: string;
  control: {
    id: string;
    'aria-describedby'?: string | undefined;
    'aria-invalid'?: true | undefined;
  };
}) {
  if (field.options)
    return (
      <Select
        {...control}
        options={field.options}
        value={typeof value === 'string' ? value : undefined}
        onValueChange={onChange}
      />
    );
  if (field.widget === 'boolean')
    return (
      <Select
        {...control}
        options={[
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]}
        value={value === true ? 'yes' : value === false ? 'no' : undefined}
        onValueChange={(v) => onChange(v === 'yes')}
      />
    );
  if (field.widget === 'number')
    return (
      <NumberField
        {...control}
        className="w-full"
        value={typeof value === 'number' ? value : null}
        onValueChange={(n) =>
          onChange(n === null ? undefined : field.type === 'integer' ? Math.trunc(n) : n)
        }
      />
    );
  if (field.widget === 'datetime') {
    const zone = timeZone;
    return (
      <DateTimeField
        id={control.id}
        defaultZone={zone}
        value={
          typeof value === 'string' ? { local: isoToLocal(value, zone), zone } : { local: '', zone }
        }
        onChange={(v) => onChange(v?.local ? localToIso(v.local, v.zone) : undefined)}
      />
    );
  }
  return (
    <Input
      {...control}
      type={
        field.widget === 'date'
          ? 'date'
          : field.widget === 'email'
            ? 'email'
            : field.widget === 'url'
              ? 'url'
              : 'text'
      }
      value={typeof value === 'string' ? value : ''}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
    />
  );
}
