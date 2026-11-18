import type { ScanAction } from '@/passkit/types.ts';
import { useDesigner } from '../../context.tsx';
import { PickEdit, TextEdit } from '../../controls.tsx';
import { readInputs } from '../../inputs.ts';
import { NumEdit } from './fields.tsx';

const STAFF = '__staff';

/** The value a Set action writes: fixed, or left for staff to pick or type. */
export function SetValue({ action, error }: { action: ScanAction; error?: string | undefined }) {
  const { doc, edit } = useDesigner();
  const spec = readInputs(doc.manifest).find((s) => s.name === action.input);
  const put = (value: ScanAction['value'] | null, merge?: string) =>
    edit({ op: 'scan-action-set', id: action.id, patch: { value } }, merge);
  const merge = `act-value:${action.id}`;
  if (!spec) return null;
  if (spec.type === 'choice' || spec.type === 'boolean') {
    const options =
      spec.type === 'boolean'
        ? [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]
        : (spec.options ?? []).map((o) => ({ value: o.value, label: o.label }));
    const current = action.value === undefined ? STAFF : String(action.value);
    return (
      <PickEdit
        label="Value"
        value={current}
        options={[{ value: STAFF, label: 'Staff pick' }, ...options]}
        help="Fixed, or staff pick one."
        onPick={(v) => put(v === STAFF ? null : spec.type === 'boolean' ? v === 'true' : v)}
      />
    );
  }
  if (spec.type === 'number')
    return (
      <NumEdit
        label="Value"
        value={typeof action.value === 'number' ? action.value : undefined}
        merge={merge}
        help="Empty: staff type one."
        error={error}
        op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { value: v } })}
      />
    );
  return (
    <TextEdit
      label="Value"
      value={typeof action.value === 'string' ? action.value : ''}
      merge={merge}
      help="Empty: staff type one."
      error={error}
      op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { value: v === '' ? null : v } })}
    />
  );
}
