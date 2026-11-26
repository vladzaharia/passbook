import type { ScanAction, ScanRole, ValidationIssue } from '@/passkit/types.ts';
import type { ResolvedScanAction } from '@/shared/scan-defaults.ts';
import { SegmentedControl, SwitchRow } from '../../../../../ui/index.ts';
import { useDesigner } from '../../context.tsx';
import { PickEdit, TextEdit } from '../../controls.tsx';
import { AmountFields } from './amount-fields.tsx';
import { IssueList, NumEdit } from './fields.tsx';
import { actionSummary, inputsFor, KINDS, REPEATS, ROLES } from './model.ts';
import { moneyDigits } from './money-digits.ts';
import { SetValue } from './set-value.tsx';

const NONE = '__none';

const keyOf = (i: ValidationIssue) => (i.path ?? '').split('.')[3] ?? '';
/** The message of the first issue at a setting, shown at its field. */
const at = (issues: readonly ValidationIssue[], key: string) =>
  issues.find((i) => keyOf(i) === key)?.message;
const FIELDS = new Set([
  'label',
  'amount',
  'confirmAbove',
  'value',
  'cooldownMinutes',
  'rewardLabel',
]);

/** Everything one action does: what, on which input, how often, who, and what staff are asked. */
export function ActionEditor({
  action,
  resolved,
  issues,
}: {
  action: ScanAction;
  resolved: ResolvedScanAction;
  issues: readonly ValidationIssue[];
}) {
  const { doc, edit, readOnly } = useDesigner();
  const set = (patch: Partial<Record<keyof ScanAction, unknown>>) =>
    edit({ op: 'scan-action-set', id: action.id, patch: patch as never });
  const inputs = inputsFor(doc, action.kind);
  const digits = moneyDigits(doc, action);
  const kind = KINDS.find((k) => k.value === action.kind);
  const merge = (k: string) => `act-${k}:${action.id}`;
  const loose = issues.filter((i) => !FIELDS.has(keyOf(i)));
  return (
    <div className="dz-editor grid gap-4">
      <IssueList issues={loose} label={`${action.label} issues`} />
      <TextEdit
        label="Label"
        value={action.label}
        merge={merge('label')}
        error={at(issues, 'label')}
        inputProps={{ maxLength: 40 }}
        op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { label: v } })}
      />
      <PickEdit
        label="Does"
        value={action.kind}
        options={KINDS}
        help={kind?.hint}
        onPick={(v) => edit({ op: 'scan-action-kind', id: action.id, kind: v as never })}
      />
      {action.kind === 'use_up' ? null : (
        <PickEdit
          label={action.kind === 'check_in' ? 'Records' : 'On'}
          value={action.input ?? NONE}
          options={[
            ...(action.kind === 'check_in' ? [{ value: NONE, label: 'Nothing' }] : []),
            ...inputs,
            ...(action.input && !inputs.some((o) => o.value === action.input)
              ? [{ value: action.input, label: action.input }]
              : []),
          ]}
          help={
            inputs.length === 0 && action.kind !== 'check_in'
              ? 'Add a matching input first.'
              : undefined
          }
          onPick={(v) => set({ input: v === NONE ? null : v })}
        />
      )}
      {action.kind === 'add' || action.kind === 'take' ? (
        <AmountFields
          action={action}
          digits={digits}
          amount={resolved.amount}
          errors={{ amount: at(issues, 'amount'), confirmAbove: at(issues, 'confirmAbove') }}
        />
      ) : null}
      {action.kind === 'take' ? (
        <TextEdit
          label="Reward"
          value={action.rewardLabel ?? ''}
          merge={merge('reward')}
          help="Shown when this redeems, such as Free coffee."
          error={at(issues, 'rewardLabel')}
          op={(v) => ({
            op: 'scan-action-set',
            id: action.id,
            patch: { rewardLabel: v === '' ? null : v },
          })}
        />
      ) : null}
      {action.kind === 'set' ? <SetValue action={action} error={at(issues, 'value')} /> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <PickEdit
          label="How often"
          value={resolved.repeat}
          options={REPEATS}
          onPick={(v) => set({ repeat: v, ...(v === 'cooldown' ? {} : { cooldownMinutes: null }) })}
        />
        {resolved.repeat === 'cooldown' ? (
          <NumEdit
            label="Wait"
            unit="min"
            min={1}
            step={1}
            value={resolved.cooldownMinutes}
            merge={merge('wait')}
            error={at(issues, 'cooldownMinutes')}
            op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { cooldownMinutes: v } })}
          />
        ) : null}
      </div>
      <SegmentedControl
        label="Who can do this"
        block
        value={resolved.minRole}
        options={ROLES}
        onValueChange={(v: ScanRole) => set({ minRole: v })}
      />
      <SwitchRow
        label="Ask to confirm"
        checked={resolved.confirm}
        disabled={readOnly}
        onCheckedChange={(confirm) => set({ confirm })}
      />
      {action.kind === 'check_in' ? (
        <SwitchRow
          label="Offer Let in again"
          checked={resolved.allowAgain}
          disabled={readOnly}
          onCheckedChange={(allowAgain) => set({ allowAgain })}
        />
      ) : null}
      <SwitchRow
        label="Send a lock-screen message"
        help="Spends the daily push budget."
        checked={resolved.notify}
        disabled={readOnly}
        onCheckedChange={(notify) => set({ notify })}
      />
      <SwitchRow
        label="Allow on connected inputs"
        help="The scan takes the field over from its connection."
        checked={resolved.allowOnConnected}
        disabled={readOnly}
        onCheckedChange={(allowOnConnected) => set({ allowOnConnected })}
      />
      <p className="text-xs text-fg-muted">{actionSummary(resolved)}</p>
    </div>
  );
}
