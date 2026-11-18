import { useState } from 'react';
import type { ScanAction } from '@/passkit/types.ts';
import { digitsMessage } from '@/shared/money.ts';
import { SegmentedControl } from '../../../../../ui/index.ts';
import { useDesigner } from '../../context.tsx';
import { ListEdit, MoneyEdit, NumEdit, parseAmount } from './fields.tsx';
import type { ActionPatch } from './ops.ts';

type Staff = { max: number; presets?: number[]; default?: number };
const DEFAULT_MAX = 10;

/** How much an add or a take moves: a fixed amount, or staff enter one up to a maximum. */
export function AmountFields({
  action,
  amount,
  errors,
  digits,
}: {
  /** Minor digits of the currency when the input is money; null for plain numbers. */
  digits: number | null;
  action: ScanAction;
  /** The amount in effect, defaults applied. */
  amount: ScanAction['amount'];
  errors: { amount?: string | undefined; confirmAbove?: string | undefined };
}) {
  const { edit } = useDesigner();
  const set = (patch: ActionPatch, merge?: string) =>
    edit({ op: 'scan-action-set', id: action.id, patch }, merge);
  const staff = typeof amount === 'object' && amount !== null;
  const detail = staff ? (amount as Staff) : null;
  const merge = (k: string) => `act-${k}:${action.id}`;
  const patchStaff = (next: Partial<Staff>) => set(withStaff(next), merge('amount'));
  const [presetError, setPresetError] = useState<string | undefined>();
  const money = digits !== null;
  /** A number, or money typed as decimal text in the currency's digits. */
  const amountField = (
    label: string,
    value: number | undefined,
    key: string,
    write: (v: number | null) => ActionPatch,
    opts: { error?: string | undefined; help?: string; min: number },
  ) =>
    money ? (
      <MoneyEdit
        key={`${key}:${value}`}
        label={label}
        value={value}
        digits={digits}
        help={opts.help}
        error={opts.error}
        onCommit={(v) => set(write(v))}
      />
    ) : (
      <NumEdit
        label={label}
        value={value}
        merge={merge(key)}
        min={opts.min}
        help={opts.help}
        error={opts.error}
        op={(v) => ({ op: 'scan-action-set', id: action.id, patch: write(v) })}
      />
    );
  const withStaff = (next: { [K in keyof Staff]?: Staff[K] | null }): ActionPatch => {
    const out: Record<string, unknown> = { ...detail, ...next };
    for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
    return { amount: out as unknown as Staff };
  };
  const presets = (list: string[]) => {
    const values: number[] = [];
    for (const text of list) {
      const r = money ? parseAmount(text, digits) : { value: Number(text) };
      if ('error' in r) return setPresetError(r.error);
      if (Number.isFinite(r.value)) values.push(r.value);
    }
    setPresetError(undefined);
    patchStaff({ presets: values });
  };
  return (
    <div className="grid gap-4">
      <SegmentedControl
        label="Amount"
        block
        value={staff ? 'staff' : 'fixed'}
        options={[
          { value: 'fixed', label: 'Fixed' },
          { value: 'staff', label: 'Staff enter' },
        ]}
        onValueChange={(v) => set({ amount: v === 'staff' ? { max: DEFAULT_MAX } : 1 })}
      />
      {detail ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {amountField('Most', detail.max, 'max', (v) => withStaff({ max: v ?? DEFAULT_MAX }), {
            error: errors.amount,
            min: 1,
          })}
          {amountField('Starts at', detail.default, 'start', (v) => withStaff({ default: v }), {
            min: 1,
          })}
          <ListEdit
            key={(detail.presets ?? []).join(',')}
            label="Quick amounts"
            help={
              money
                ? `Up to six, separated by commas. ${digitsMessage(digits)}`
                : 'Up to six, separated by commas.'
            }
            error={presetError}
            value={(detail.presets ?? []).map((p) => (money ? p.toFixed(digits) : String(p)))}
            onCommit={presets}
          />
        </div>
      ) : (
        amountField(
          'Amount',
          typeof amount === 'number' ? amount : undefined,
          'fixed',
          (v) => ({ amount: v ?? 1 }),
          { error: errors.amount, min: 1 },
        )
      )}
      {amountField(
        'Ask to confirm above',
        action.confirmAbove,
        'above',
        (v) => ({ confirmAbove: v }),
        { error: errors.confirmAbove, help: 'Larger amounts need a second tap.', min: 0 },
      )}
    </div>
  );
}
