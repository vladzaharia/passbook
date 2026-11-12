import type { ScanRowDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanRole } from '@/passkit/types.ts';
import { CheckboxField, Combobox, FormField } from '../../../../ui/index.ts';
import { type Manifest, type Pass, scanBindingOptions } from './scan-fields.tsx';
import { actionList, Numeric, Pick, type RowProps, title } from './scan-row-editor-common.tsx';

const SHOW_DEFAULTS = {
  value: ['amount', 'when'],
  visits: ['when', 'where'],
  scans: ['when', 'action'],
} as const;
export function HistoryEditor({
  row,
  manifest,
  passJson,
  role,
  onChange,
}: {
  row: Extract<ScanRowDoc, { type: 'history' }>;
  manifest: Manifest;
  passJson?: Pass;
  role: ScanRole;
  onChange: RowProps['onChange'];
}) {
  const set = (patch: Record<string, unknown>, merge?: string) =>
    onChange({ ...row, ...patch } as ScanRowDoc, merge);
  const paths = new Set(
    scanBindingOptions(manifest, role, passJson)
      .filter((o) => !o.disabled)
      .map((o) => o.value),
  );
  const inputs = [
    ...new Set(
      actionList(manifest)
        .filter(
          (a) =>
            a.input && ['add', 'take', 'set'].includes(a.kind) && paths.has(`inputs.${a.input}`),
        )
        .map((a) => a.input as string),
    ),
  ];
  const inputOptions = inputs.map((input) => ({ value: input, label: input }));
  const show = Array.isArray(row.show)
    ? row.show
    : [...(SHOW_DEFAULTS[row.source] ?? SHOW_DEFAULTS.scans)];
  return (
    <>
      <Pick
        label="History source"
        value={row.source}
        options={[
          { value: 'value', label: 'Value changes' },
          { value: 'visits', label: 'Visits' },
          { value: 'scans', label: 'Scans' },
        ]}
        onChange={(source) =>
          set({
            source,
            input: source === 'value' ? (row.input ?? inputs[0]) : undefined,
            show: undefined,
          })
        }
      />
      {row.source === 'value' ? (
        <FormField
          label="Tracked input"
          help="Only inputs changed by a scan action can have a ledger."
        >
          {(control) => (
            <Combobox
              {...control}
              options={inputOptions}
              value={row.input && inputs.includes(row.input) ? row.input : undefined}
              placeholder="Choose an input"
              searchPlaceholder="Find an input"
              onValueChange={(input) => set({ input })}
            />
          )}
        </FormField>
      ) : null}
      <Numeric
        label="Maximum entries"
        value={row.limit}
        min={1}
        max={5}
        integer
        placeholder="3"
        mergeKey={`scan:${row.id}:limit`}
        onChange={(limit, merge) => set({ limit }, merge)}
      />
      <div className="grid gap-2">
        <span className="text-sm font-medium text-fg-strong">Show in each entry</span>
        {(['amount', 'when', 'where', 'action'] as const).map((item) => (
          <CheckboxField
            key={item}
            label={title(item)}
            checked={(show as readonly string[]).includes(item)}
            onCheckedChange={(checked) => {
              const next =
                checked === true ? [...show, item] : show.filter((entry) => entry !== item);
              set({ show: next });
            }}
          />
        ))}
      </div>
    </>
  );
}
