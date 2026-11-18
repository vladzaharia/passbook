import { Validator } from '@cfworker/json-schema';
import { addStamps, redeem } from '../../../passkit/stamps/rules.ts';
import { counterSizes } from '../../../passkit/template/counters.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import { currencyOf, isCurrencyInput } from '../../../passkit/template/scan-actions.ts';
import type { Json, Personalization, TemplateManifest } from '../../../passkit/types.ts';
import { digitsMessage, fromMinor, minorDigits, toMinor } from '../../../shared/money.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { PassStatus } from '../passes/repo-map.ts';

/** A staff-entered or fixed amount never exceeds this (the template validator's bound). */
export const MAX_AMOUNT = 1000;

/** What an add or take actually moved: the daily amount counts this, not what was asked. */
export function appliedAmount(effect: Pick<ValueEffect, 'before' | 'after'>): number {
  // Rounded so a money change is the amount asked, not its binary float residue.
  return Math.round(Math.abs(numberOf(effect.after) - numberOf(effect.before)) * 1e8) / 1e8;
}

export type EffectStopReason =
  | 'no_balance'
  | 'card_full'
  | 'voided'
  | 'managed_elsewhere'
  | 'limit_reached'
  | 'stale';

/**
 * The action cannot apply: the scan closes with this reason (a heads-up for `stale`, a refusal for
 * the rest) and nothing was written to the pass or the gate. `have` is the input's value now.
 */
export class ScanEffectStop extends Error {
  readonly reason: EffectStopReason;
  readonly have: Json;
  constructor(reason: EffectStopReason, have: Json = null) {
    super(reason);
    this.reason = reason;
    this.have = have;
  }
}

export interface ValueEffect {
  /** The pass's input after the effect; the personalization keeps every other key. */
  personalization: Personalization;
  status: PassStatus;
  before: Json;
  after: Json;
  /** False when the pass would be left as it is: nothing is published. */
  changed: boolean;
}

type Schema = Record<string, unknown>;

export const schemaOf = (manifest: TemplateManifest, input: string): Schema | null => {
  const props = manifest.inputs?.properties as Record<string, unknown> | undefined;
  const schema = props?.[input];
  return schema && typeof schema === 'object' ? (schema as Schema) : null;
};

const numberOf = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The amount a request applies: the action's fixed one, or the staff's, or the default. */
export function amountOf(action: ResolvedScanAction, requested: number | undefined): number {
  const set = action.amount;
  if (typeof set === 'number') return set;
  return requested ?? set?.default ?? 1;
}

/** Minor digits of a money input in this pass's currency; null for any other input. */
export function moneyDigits(
  manifest: TemplateManifest,
  input: string,
  values: Record<string, unknown>,
): number | null {
  return isCurrencyInput(schemaOf(manifest, input))
    ? minorDigits(currencyOf(manifest, input, values))
    : null;
}

export interface ValueRequestIssue {
  code: 'SCAN_AMOUNT_INVALID' | 'SCAN_VALUE_INVALID';
  message: string;
}

/** What a request must hold before anything is reserved: the amount of an add or take, the value of a set. */
export function valueRequestIssue(
  action: ResolvedScanAction,
  manifest: TemplateManifest,
  body: { amount?: number | undefined; value?: unknown },
  personalization: Personalization = {},
): ValueRequestIssue | null {
  const schema = action.input ? schemaOf(manifest, action.input) : null;
  if (action.kind === 'add' || action.kind === 'take') {
    const amount = amountOf(action, body.amount);
    const integer = schema?.type === 'integer';
    const digits = action.input
      ? moneyDigits(manifest, action.input, applyDefaults(manifest, personalization))
      : null;
    if (digits !== null) {
      if (
        typeof action.amount === 'number' &&
        body.amount !== undefined &&
        body.amount !== action.amount
      )
        return { code: 'SCAN_AMOUNT_INVALID', message: 'This action has a fixed amount.' };
      const minor = toMinor(amount, digits);
      if (minor === null) return { code: 'SCAN_AMOUNT_INVALID', message: digitsMessage(digits) };
      if (minor < 1 || amount > MAX_AMOUNT)
        return {
          code: 'SCAN_AMOUNT_INVALID',
          message: `Enter an amount from ${fromMinor(1, digits).toFixed(digits)} to ${MAX_AMOUNT}.`,
        };
      return null;
    }
    if (
      typeof action.amount === 'number' &&
      body.amount !== undefined &&
      body.amount !== action.amount
    )
      return { code: 'SCAN_AMOUNT_INVALID', message: 'This action has a fixed amount.' };
    if (!(amount > 0 && amount <= MAX_AMOUNT) || (integer && !Number.isInteger(amount)))
      return { code: 'SCAN_AMOUNT_INVALID', message: `Enter an amount from 1 to ${MAX_AMOUNT}.` };
    return null;
  }
  if (action.kind === 'set') {
    const value = action.value ?? body.value;
    const valid =
      value !== undefined &&
      schema !== null &&
      new Validator(schema as never, '2020-12', false).validate(value as Json).valid;
    return valid ? null : { code: 'SCAN_VALUE_INVALID', message: 'That value does not fit.' };
  }
  return null;
}

/**
 * The pure effect of one value action on the pass as it is now (SA 7.4). It is re-run on every
 * compare-and-swap attempt, so two desks adding at once both count. Throws `ScanEffectStop` when
 * the action cannot apply.
 */
export function valueEffect(
  action: ResolvedScanAction,
  manifest: TemplateManifest,
  current: { personalization: Personalization; status: PassStatus },
  body: { amount?: number | undefined; value?: unknown },
  /** A lower maximum than the input's own: a release waiting to reissue the card sets one. */
  cap?: number,
): ValueEffect {
  const input = action.input ?? '';
  const values = applyDefaults(manifest, current.personalization);
  const keep = (value: Json, status: PassStatus = current.status): ValueEffect => {
    const before = values[input] ?? null;
    return {
      personalization: { ...current.personalization, [input]: value },
      status,
      before: before as Json,
      after: value,
      changed: JSON.stringify(before) !== JSON.stringify(value) || status !== current.status,
    };
  };
  if (action.kind === 'use_up')
    return {
      personalization: current.personalization,
      status: 'voided',
      before: 'active',
      after: 'voided',
      changed: current.status !== 'voided',
    };
  if (action.kind === 'set') return keep((action.value ?? body.value) as Json);
  const have = numberOf(values[input]);
  const amount = amountOf(action, body.amount);
  const schema = schemaOf(manifest, input);
  const stamps = manifest.stamps?.input === input ? manifest.stamps : undefined;
  const digits = moneyDigits(manifest, input, values);
  if (digits !== null) return moneyEffect(action, digits, { have, amount, schema, cap, keep });
  if (action.kind === 'add') {
    const own = typeof schema?.maximum === 'number' ? schema.maximum : Number.POSITIVE_INFINITY;
    const maximum = Math.min(own, cap ?? Number.POSITIVE_INFINITY);
    if (stamps) {
      const next = addStamps(have, amount, maximum);
      if (next === null) throw new ScanEffectStop('card_full', have);
      return keep(next);
    }
    // A refill carries over what is left: past the input's maximum it is refused, never clamped.
    if (counterSizes(manifest)[input] !== undefined) {
      if (have + amount > maximum) throw new ScanEffectStop('card_full', have);
      return keep(have + amount);
    }
    // Never below what it holds: a cap that fell under the count leaves it as it is.
    return keep(have >= maximum ? have : Math.min(have + amount, maximum));
  }
  // take: a stamp card's reward takes the goal off, and nothing short of it
  if (stamps && amount === stamps.goal) {
    const next = redeem(have, stamps.goal);
    if (next === null) throw new ScanEffectStop('no_balance', have);
    return keep(next);
  }
  if (have < amount) throw new ScanEffectStop('no_balance', have);
  return keep(have - amount);
}

/** An add or take on a money input, counted in minor units so 10.10 - 4.50 is exactly 5.60. */
function moneyEffect(
  action: ResolvedScanAction,
  digits: number,
  {
    have,
    amount,
    schema,
    cap,
    keep,
  }: {
    have: number;
    amount: number;
    schema: Schema | null;
    cap: number | undefined;
    keep: (value: Json) => ValueEffect;
  },
): ValueEffect {
  const minor = (v: number) => Math.round(v * 10 ** digits);
  const held = minor(have);
  const step = minor(amount);
  if (action.kind === 'take') {
    if (held < step) throw new ScanEffectStop('no_balance', have);
    return keep(fromMinor(held - step, digits));
  }
  const own = typeof schema?.maximum === 'number' ? schema.maximum : Number.POSITIVE_INFINITY;
  const top = Math.min(own, cap ?? Number.POSITIVE_INFINITY);
  const maximum = Number.isFinite(top) ? minor(top) : top;
  // Never below what it holds: a cap that fell under the balance leaves it as it is.
  return keep(fromMinor(held >= maximum ? held : Math.min(held + step, maximum), digits));
}

/** The `currency` of a money value's card line; nothing for any other input. */
export function currencyField(
  manifest: TemplateManifest,
  input: string,
  personalization: Personalization,
): { currency?: string } {
  if (!isCurrencyInput(schemaOf(manifest, input))) return {};
  const code = currencyOf(manifest, input, applyDefaults(manifest, personalization));
  return code ? { currency: code } : {};
}
