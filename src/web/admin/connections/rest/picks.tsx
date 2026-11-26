import { pointerToJsonPath } from '@/shared/rest/json-path.ts';
import { FormField, Input } from '../../../ui/index.ts';
import type { FormValues } from '../../passes/schema-form/index.ts';
import { jsonPathOf } from './path-crumbs.tsx';
import { DEFAULT_ID, DEFAULT_RECORDS, KEY } from './rest-values.ts';

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/** A pointer is empty or starts with a slash. */
const pointerError = (v: string) => (v === '' || v.startsWith('/') ? undefined : 'Start with /.');

/** The three response paths as plain fields, so they work with no sample too. */
export function Picks({
  value,
  onChange,
  disabled,
}: {
  value: FormValues;
  onChange: (patch: FormValues) => void;
  disabled?: boolean;
}) {
  const records = str(value[KEY.records], DEFAULT_RECORDS);
  const id = str(value[KEY.id], DEFAULT_ID);
  const email = str(value[KEY.email]);
  const rows = [
    {
      key: KEY.records,
      label: 'Records',
      value: records,
      hint: `${pointerToJsonPath(records)}[*]`,
      placeholder: '/data',
    },
    {
      key: KEY.id,
      label: 'Record ID',
      value: id,
      hint: jsonPathOf(`${records}/0${id}`, records),
      placeholder: '/id',
    },
    {
      key: KEY.email,
      label: 'Holder email',
      value: email,
      hint: email ? jsonPathOf(`${records}/0${email}`, records) : undefined,
      placeholder: '/email',
    },
  ];
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-3">
      {rows.map((r) => (
        <FormField key={r.key} label={r.label} error={pointerError(r.value)} help={r.hint}>
          {(f) => (
            <Input
              {...f}
              className="font-mono"
              value={r.value}
              placeholder={r.placeholder}
              disabled={disabled}
              onChange={(e) => onChange({ [r.key]: e.target.value })}
            />
          )}
        </FormField>
      ))}
    </div>
  );
}
