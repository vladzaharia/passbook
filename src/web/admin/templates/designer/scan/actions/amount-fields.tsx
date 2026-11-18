import type { ScanAction } from '@/passkit/types.ts';
import { SegmentedControl } from '../../../../../ui/index.ts';
import { useDesigner } from '../../context.tsx';
import { ListEdit, NumEdit } from './fields.tsx';
import type { ActionPatch } from './ops.ts';

type Staff = { max: number; presets?: number[]; default?: number };
const DEFAULT_MAX = 10;

/** How much an add or a take moves: a fixed amount, or staff enter one up to a maximum. */
export function AmountFields({
  action,
  amount,
  errors,
}: {
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
  const patchStaff = (next: Partial<Staff>) => {
    const out: Record<string, unknown> = { ...detail, ...next };
    for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === null) delete out[k];
    if (Array.isArray(out.presets) && out.presets.length === 0) delete out.presets;
    set({ amount: out as unknown as Staff }, merge('amount'));
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
          <NumEdit
            label="Most"
            value={detail.max}
            merge={merge('max')}
            min={1}
            error={errors.amount}
            op={(v) => ({
              op: 'scan-action-set',
              id: action.id,
              patch: { amount: { ...detail, max: v ?? DEFAULT_MAX } },
            })}
          />
          <NumEdit
            label="Starts at"
            value={detail.default}
            merge={merge('start')}
            min={1}
            op={(v) => {
              const { default: _d, ...rest } = detail;
              return {
                op: 'scan-action-set',
                id: action.id,
                patch: { amount: v === null ? rest : { ...rest, default: v } },
              };
            }}
          />
          <ListEdit
            label="Quick amounts"
            help="Up to six, separated by commas."
            value={(detail.presets ?? []).map(String)}
            onCommit={(list) =>
              patchStaff({ presets: list.map(Number).filter((n) => Number.isFinite(n)) })
            }
          />
        </div>
      ) : (
        <NumEdit
          label="Amount"
          value={typeof amount === 'number' ? amount : undefined}
          merge={merge('fixed')}
          min={1}
          error={errors.amount}
          op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { amount: v ?? 1 } })}
        />
      )}
      <NumEdit
        label="Ask to confirm above"
        value={action.confirmAbove}
        merge={merge('above')}
        min={0}
        help="Larger amounts need a second tap."
        error={errors.confirmAbove}
        op={(v) => ({ op: 'scan-action-set', id: action.id, patch: { confirmAbove: v } })}
      />
    </div>
  );
}
