import { Minus, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import type { ScanActionInput, ScanCard } from '../../../shared/contracts/scan.ts';
import { digitsMessage, fromMinor, minorDigits, parseMoney } from '../../../shared/money.ts';
import { formatCount, formatMoney } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { ScanTextField } from '../input/wedge-field.tsx';
import { useDraftOnScreen } from '../machine/draft-health.ts';
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
  onAmount: (value: number | null) => void;
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
  if (only?.format === 'currency')
    return (
      <MoneyPicker
        label={action.label}
        take={action.kind === 'take'}
        range={range}
        value={only}
        amount={draft.amount}
        onAmount={onAmount}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
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

/** An add or take on money: preset chips and a decimal field, in the currency's own digits. */
function MoneyPicker({
  label,
  take,
  range,
  value,
  amount,
  onAmount,
  onConfirm,
  onCancel,
}: {
  label: string;
  take: boolean;
  range: { presets: number[] } | null;
  value: ScanCard['values'][number];
  amount: number | null | undefined;
  onAmount: (value: number | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const onScreen = useDraftOnScreen();
  const digits = minorDigits(value.currency);
  const currency = value.currency ?? null;
  const [text, setText] = useState(amount ? amount.toFixed(digits) : '');
  const errorId = useId();
  const parsed = parseMoney(text, digits);
  const minor = 'minor' in parsed ? parsed.minor : 0;
  const current = minor > 0 ? fromMinor(minor, digits) : 0;
  const before = typeof value.before === 'number' ? value.before : null;
  const beforeMinor = before === null ? null : Math.round(before * 10 ** digits);
  const after =
    beforeMinor === null || minor === 0
      ? null
      : fromMinor(take ? beforeMinor - minor : beforeMinor + minor, digits);
  const short = take && after !== null && after < 0;
  const error =
    text === '' || 'minor' in parsed
      ? null
      : parsed.error === 'digits'
        ? digitsMessage(digits)
        : 'Enter an amount.';
  const set = (next: string) => {
    setText(next);
    const p = parseMoney(next, digits);
    // An empty or invalid field is no amount: the customer screen stops showing the last one.
    onAmount('minor' in p && p.minor > 0 ? fromMinor(p.minor, digits) : null);
  };
  return (
    <div className="scan-picker" data-testid="scan-picker">
      <h2 className="scan-picker-title">{label}</h2>
      {range?.presets.length ? (
        <fieldset className="scan-picker-presets" aria-label="Amount">
          {range.presets.map((n) => (
            <Button
              key={n}
              size="lg"
              variant={n === current ? 'primary' : 'outline'}
              aria-pressed={n === current}
              onClick={() => set(n.toFixed(digits))}
            >
              {formatMoney(n, currency)}
            </Button>
          ))}
        </fieldset>
      ) : null}
      <ScanTextField
        aria-label="Amount"
        data-testid="scan-money-input"
        inputMode="decimal"
        autoComplete="off"
        placeholder={(0).toFixed(digits)}
        aria-invalid={error !== null}
        {...(error ? { 'aria-describedby': errorId } : {})}
        value={text}
        onChange={(event) => set(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && minor > 0 && !short) onConfirm();
        }}
      />
      {error ? (
        <p id={errorId} className="scan-picker-change" role="alert" data-testid="scan-money-error">
          {error}
        </p>
      ) : null}
      {after !== null ? (
        <p className="scan-picker-change" data-testid="scan-picker-change">
          Balance after: {formatMoney(after, currency)}
        </p>
      ) : null}
      {onScreen && minor > 0 ? (
        <p className="scan-picker-onscreen" data-testid="scan-draft-onscreen">
          On screen
        </p>
      ) : null}
      <div className="scan-picker-actions">
        <Button size="lg" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="lg"
          data-testid="scan-picker-commit"
          disabled={minor === 0 || short}
          onClick={onConfirm}
        >
          {minor > 0 ? `${label} ${formatMoney(current, currency)}` : label}
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
