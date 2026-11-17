import { Minus, Plus } from 'lucide-react';
import type { ScanActionInput, ScanCard } from '../../../shared/contracts/scan.ts';
import { formatCount } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import type { Draft } from '../machine/types.ts';
import './picker.css';

/** The desk's amount: presets, a stepper and what the value will be. Confirm sends it. */
export function ValuePicker({
  card,
  draft,
  onAmount,
  onValue,
  onConfirm,
  onCancel,
}: {
  card: ScanCard;
  draft: Draft;
  onAmount: (value: number) => void;
  onValue: (value: unknown) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const action = card.actions.find((a) => a.id === draft.actionId);
  if (!action) return null;
  if (action.kind === 'set' && action.input)
    return (
      <SetPicker
        label={action.label}
        input={action.input}
        value={draft.value}
        onValue={onValue}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
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

const bad = (input: ScanActionInput, value: unknown): boolean => {
  if (input.type === 'boolean') return typeof value !== 'boolean';
  if (input.enum) return !input.enum.includes(value as string | number);
  if (input.type === 'string')
    return (
      typeof value !== 'string' ||
      value === '' ||
      (input.maxLength ? value.length > input.maxLength : false)
    );
  return (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (input.type === 'integer' && !Number.isInteger(value)) ||
    (input.min !== undefined && value < input.min) ||
    (input.max !== undefined && value > input.max)
  );
};

/** A `set`: type or choose the value the input takes. The server validates it again. */
function SetPicker({
  label,
  input,
  value,
  onValue,
  onConfirm,
  onCancel,
}: {
  label: string;
  input: ScanActionInput;
  value: unknown;
  onValue: (value: unknown) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const choices: (string | number | boolean)[] | null =
    input.type === 'boolean' ? [true, false] : (input.enum ?? null);
  return (
    <div className="scan-picker" data-testid="scan-picker">
      <h2 className="scan-picker-title">{label}</h2>
      {choices ? (
        <fieldset className="scan-picker-presets" aria-label={input.label}>
          {choices.map((c) => (
            <Button
              key={String(c)}
              size="lg"
              variant={c === value ? 'primary' : 'outline'}
              aria-pressed={c === value}
              onClick={() => onValue(c)}
            >
              {typeof c === 'boolean' ? (c ? 'Yes' : 'No') : String(c)}
            </Button>
          ))}
        </fieldset>
      ) : (
        <ScanTextField
          aria-label={input.label}
          data-testid="scan-value-input"
          inputMode={input.type === 'string' ? 'text' : 'decimal'}
          type={input.type === 'string' ? 'text' : 'number'}
          {...(input.maxLength ? { maxLength: input.maxLength } : {})}
          {...(input.min !== undefined ? { min: input.min } : {})}
          {...(input.max !== undefined ? { max: input.max } : {})}
          step={input.step ?? (input.type === 'integer' ? 1 : 'any')}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) =>
            onValue(
              input.type === 'string'
                ? event.target.value
                : event.target.value === ''
                  ? ''
                  : Number(event.target.value),
            )
          }
        />
      )}
      <div className="scan-picker-actions">
        <Button size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="lg"
          data-testid="scan-picker-commit"
          disabled={bad(input, value)}
          onClick={onConfirm}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}
