import { Minus, Plus } from 'lucide-react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { formatCount } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import type { Draft } from '../machine/types.ts';
import './picker.css';

/** The desk's amount: presets, a stepper and what the value will be. Confirm sends it. */
export function ValuePicker({
  card,
  draft,
  onAmount,
  onConfirm,
  onCancel,
}: {
  card: ScanCard;
  draft: Draft;
  onAmount: (value: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const action = card.actions.find((a) => a.id === draft.actionId);
  if (!action) return null;
  const range = action.amount && !('fixed' in action.amount) ? action.amount : null;
  const amount = draft.amount ?? 1;
  const only = card.values.length === 1 ? card.values[0] : undefined;
  const before = typeof only?.before === 'number' ? only.before : null;
  const after = before === null ? null : action.kind === 'take' ? before - amount : before + amount;
  const short = action.kind === 'take' && after !== null && after < 0;
  const max = range?.max ?? 1000;
  return (
    <div className="scan-picker" data-testid="scan-picker">
      <h2 className="scan-picker-title">{action.label}</h2>
      {range?.presets.length ? (
        <fieldset className="scan-picker-presets" aria-label="Amount">
          {range.presets.map((n) => (
            <Button
              key={n}
              size="lg"
              variant={n === amount ? 'primary' : 'outline'}
              aria-pressed={n === amount}
              onClick={() => onAmount(n)}
            >
              {formatCount(n)}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <div className="scan-picker-stepper">
        <Button
          size="lg"
          variant="outline"
          aria-label="Less"
          data-testid="scan-amount-down"
          disabled={amount <= 1}
          onClick={() => onAmount(amount - 1)}
        >
          <Minus aria-hidden />
        </Button>
        <output className="scan-picker-amount" data-testid="scan-amount" aria-live="polite">
          {formatCount(amount)}
        </output>
        <Button
          size="lg"
          variant="outline"
          aria-label="More"
          data-testid="scan-amount-up"
          disabled={amount >= max}
          onClick={() => onAmount(amount + 1)}
        >
          <Plus aria-hidden />
        </Button>
      </div>
      {only && before !== null && after !== null ? (
        <p className="scan-picker-change" data-testid="scan-picker-change">
          {only.label}: {formatCount(before)} {'→'} {formatCount(after)}
        </p>
      ) : null}
      <div className="scan-picker-actions">
        <Button size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="lg" data-testid="scan-picker-commit" disabled={short} onClick={onConfirm}>
          {action.label} {formatCount(amount)}
        </Button>
      </div>
    </div>
  );
}
