import type { ScanRowDoc, ScanText } from '@/passkit/template/scan-display/schema.ts';
import { CheckboxField, SwitchRow } from '../../../../ui/index.ts';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { effectiveScanRole, ScanIconField, ScanRoleField } from './scan-fields.tsx';
import {
  actionList,
  NONE,
  NOTE_TONES,
  Numeric,
  Pick,
  type RowProps,
  TONES,
} from './scan-row-editor-common.tsx';
import { HistoryEditor } from './scan-row-history-editor.tsx';
import { ItemEditor } from './scan-row-item-editor.tsx';
import { ScanExpressionField, ScanTextField } from './scan-text-fields.tsx';

/** The row is replaced once per gesture; inputs send merge keys for the existing undo coalescer. */
export function ScanRowEditor({ row, manifest, onChange, role = 'door', passJson }: RowProps) {
  const id = typeof row.id === 'string' ? row.id : 'row';
  const audience = effectiveScanRole(role, row.minRole);
  const actions = row.type === 'money' ? actionList(manifest) : [];
  const set = (patch: Record<string, unknown>, merge?: string) =>
    onChange({ ...row, ...patch } as ScanRowDoc, merge);
  const text = (label: string, key: string, value: ScanText | undefined, optional = false) => (
    <ScanTextField
      key={key}
      label={label}
      value={value}
      manifest={manifest}
      passJson={passJson}
      audienceRole={audience}
      optional={optional}
      mergeKey={`scan:${id}:${key}`}
      onChange={(v, merge) => set({ [key]: v }, merge)}
    />
  );
  const expr = (label: string, key: string, value: string | undefined, optional = false) => (
    <ScanExpressionField
      key={key}
      label={label}
      value={value}
      manifest={manifest}
      passJson={passJson}
      role={audience}
      optional={optional}
      mergeKey={`scan:${id}:${key}`}
      onChange={(v, merge) => set({ [key]: v }, merge)}
    />
  );
  return (
    <div className="grid gap-4">
      {row.type === 'heading' ? (
        <>
          {text('Heading', 'text', row.text)}
          {text('Detail', 'detail', row.detail, true)}
        </>
      ) : null}
      {row.type === 'field' ? (
        <>
          {text('Label', 'label', row.label)}
          {text('Value', 'value', row.value)}
          <ScanIconField value={row.icon} onChange={(icon) => set({ icon })} />
          <SwitchRow
            label="Emphasize value"
            checked={row.strong ?? false}
            onCheckedChange={(strong) => set({ strong: strong || undefined })}
          />
          <Pick
            label="When value is empty"
            value={row.whenEmpty ?? 'hide'}
            options={[
              { value: 'hide', label: 'Hide row' },
              { value: 'dash', label: 'Show a dash' },
            ]}
            onChange={(v) => set({ whenEmpty: v === 'hide' ? undefined : v })}
          />
        </>
      ) : null}
      {row.type === 'big' ? (
        <>
          {text('Label', 'label', row.label, true)}
          {text('Value', 'value', row.value)}
          {text('Unit', 'unit', row.unit, true)}
          <Pick
            label="Tone"
            value={row.tone ?? NONE}
            options={[{ value: NONE, label: 'Default' }, ...TONES]}
            onChange={(tone) => set({ tone: tone === NONE ? undefined : tone })}
          />
        </>
      ) : null}
      {row.type === 'columns' || row.type === 'chips' || row.type === 'list' ? (
        <ItemEditor
          row={row}
          manifest={manifest}
          passJson={passJson}
          role={audience}
          onChange={onChange}
        />
      ) : null}
      {row.type === 'progress' ? (
        <>
          {expr('Progress value', 'value', row.value)}
          <Pick
            label="Goal source"
            value={
              row.goal === undefined
                ? 'auto'
                : typeof row.goal === 'number'
                  ? 'number'
                  : 'expression'
            }
            options={[
              { value: 'auto', label: 'From take action' },
              { value: 'number', label: 'Fixed goal' },
              { value: 'expression', label: 'Field or expression' },
            ]}
            onChange={(v) => set({ goal: v === 'auto' ? undefined : v === 'number' ? 10 : '' })}
          />
          {typeof row.goal === 'number' ? (
            <Numeric
              label="Goal"
              value={row.goal}
              min={1}
              max={1000}
              integer
              mergeKey={`scan:${id}:goal`}
              onChange={(goal, merge) => set({ goal }, merge)}
            />
          ) : typeof row.goal === 'string' ? (
            expr('Goal', 'goal', row.goal)
          ) : null}
          {text('Reward', 'reward', row.reward, true)}
          {expr('Rewards earned', 'rewards', row.rewards, true)}
          <ScanIconField value={row.icon} onChange={(icon) => set({ icon })} />
          <Pick
            label="Progress style"
            value={row.style ?? 'auto'}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'stamps', label: 'Stamps' },
              { value: 'bar', label: 'Bar' },
            ]}
            onChange={(style) => set({ style: style === 'auto' ? undefined : style })}
          />
        </>
      ) : null}
      {row.type === 'money' ? (
        <>
          {text('Label', 'label', row.label, true)}
          {expr('Amount', 'amount', row.amount)}
          {expr('Currency', 'currency', row.currency, true)}
          <Numeric
            label="Low balance below"
            value={row.lowBelow}
            mergeKey={`scan:${id}:lowBelow`}
            onChange={(lowBelow, merge) => set({ lowBelow }, merge)}
          />
          <div className="grid gap-2">
            <span className="text-sm font-medium text-fg-strong">
              Preview pending action amounts
            </span>
            {actions.map((action) => (
              <CheckboxField
                key={action.id}
                label={action.label}
                checked={Array.isArray(row.pending) && row.pending.includes(action.id)}
                onCheckedChange={(checked) => {
                  const previous = Array.isArray(row.pending) ? row.pending : [];
                  const pending =
                    checked === true
                      ? [...previous, action.id].slice(0, 6)
                      : previous.filter((v) => v !== action.id);
                  set({ pending: pending.length ? pending : undefined });
                }}
              />
            ))}
            {actions.length === 0 ? (
              <p className="text-xs text-fg-muted">There are no scan actions.</p>
            ) : null}
          </div>
        </>
      ) : null}
      {row.type === 'history' ? (
        <HistoryEditor
          row={row}
          manifest={manifest}
          passJson={passJson}
          role={audience}
          onChange={onChange}
        />
      ) : null}
      {row.type === 'image' ? (
        <>
          <Pick
            label="Image source"
            value={row.source}
            options={[
              { value: 'thumbnail', label: 'Thumbnail' },
              { value: 'strip', label: 'Strip' },
            ]}
            onChange={(source) => set({ source })}
          />
          {text('Title', 'title', row.title, true)}
          {text('Detail', 'detail', row.detail, true)}
        </>
      ) : null}
      {row.type === 'note' ? (
        <>
          {text('Note', 'text', row.text)}
          <Pick
            label="Tone"
            value={row.tone ?? 'neutral'}
            options={NOTE_TONES}
            onChange={(tone) => set({ tone: tone === 'neutral' ? undefined : tone })}
          />
          <ScanIconField value={row.icon} onChange={(icon) => set({ icon })} />
        </>
      ) : null}
      {row.type === 'divider' ? (
        <p className="text-sm text-fg-muted">A divider separates rows in this card.</p>
      ) : null}
      <ScanRoleField value={row.minRole} onChange={(minRole) => set({ minRole })} />
      <ScanConditionField
        value={row.when}
        manifest={manifest}
        passJson={passJson}
        audienceRole={audience}
        mergeKey={`scan:${id}:when`}
        onChange={(when, merge) => set({ when }, merge)}
      />
    </div>
  );
}
