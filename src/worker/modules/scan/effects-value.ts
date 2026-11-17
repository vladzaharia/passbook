import { Validator } from '@cfworker/json-schema';
import { addStamps, redeem } from '../../../passkit/stamps/rules.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { Json, Personalization, TemplateManifest } from '../../../passkit/types.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { PassStatus } from '../passes/repo-map.ts';

/** A staff-entered or fixed amount never exceeds this (the template validator's bound). */
export const MAX_AMOUNT = 1000;

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

export interface ValueRequestIssue {
  code: 'SCAN_AMOUNT_INVALID' | 'SCAN_VALUE_INVALID';
  message: string;
}

/** What a request must hold before anything is reserved: the amount of an add or take, the value of a set. */
export function valueRequestIssue(
  action: ResolvedScanAction,
  manifest: TemplateManifest,
  body: { amount?: number | undefined; value?: unknown },
): ValueRequestIssue | null {
  const schema = action.input ? schemaOf(manifest, action.input) : null;
  if (action.kind === 'add' || action.kind === 'take') {
    const amount = amountOf(action, body.amount);
    const integer = schema?.type === 'integer';
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
  if (action.kind === 'add') {
    const own = typeof schema?.maximum === 'number' ? schema.maximum : Number.POSITIVE_INFINITY;
    const maximum = Math.min(own, cap ?? Number.POSITIVE_INFINITY);
    if (stamps) {
      const next = addStamps(have, amount, maximum);
      if (next === null) throw new ScanEffectStop('card_full', have);
      return keep(next);
    }
    return keep(Math.min(have + amount, maximum));
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
