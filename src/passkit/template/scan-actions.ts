import { Validator } from '@cfworker/json-schema';
import { minorDigits, toMinor } from '../../shared/money.ts';
import { schemaFor } from '../../shared/safe-pattern.ts';
import type { Json, TemplateManifest } from '../types.ts';
import { exprReferences } from './expr.ts';

const ID = /^[a-z][a-z0-9_]{0,31}$/;
const KINDS = new Set(['check_in', 'add', 'take', 'set', 'use_up']);
const REPEATS = new Set(['once', 'daily', 'cooldown', 'always']);
const ROLES = new Set(['door', 'desk', 'manager']);
const ACTION_KEYS = new Set([
  'id',
  'label',
  'kind',
  'input',
  'amount',
  'value',
  'repeat',
  'cooldownMinutes',
  'minRole',
  'confirm',
  'confirmAbove',
  'allowAgain',
  'rewardLabel',
  'notify',
  'allowOnConnected',
]);
const BOOLEAN_KEYS = ['confirm', 'allowAgain', 'notify', 'allowOnConnected'] as const;

const MAX_ACTIONS = 6;
export const MAX_LABEL = 24;
/** A staff-entered or fixed amount never exceeds this. */
const MAX_AMOUNT = 1000;
const MAX_COOLDOWN_MINUTES = 10080;

export type Rec = Record<string, unknown>;
export const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const label = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '' && Array.from(v).length <= MAX_LABEL;

export function propertiesOf(manifest: TemplateManifest): Rec {
  const p = (manifest.inputs as { properties?: unknown } | undefined)?.properties;
  return isRecord(p) ? p : {};
}

export function typeOf(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  const t = schema.type;
  return typeof t === 'string' ? t : null;
}

/** An input whose number is money (`x-format: currency`): amounts are exact in minor units. */
export const isCurrencyInput = (schema: unknown) =>
  isRecord(schema) && schema['x-format'] === 'currency';

/**
 * The ISO code a currency input is in: its own `x-currency`, else the `currencyCode` bound to the
 * field that shows it (a literal, or an input read from `values`, falling back to its default).
 */
export function currencyOf(
  manifest: TemplateManifest,
  input: string,
  values: Rec = {},
): string | null {
  const props = propertiesOf(manifest);
  const own = isRecord(props[input]) ? props[input]['x-currency'] : undefined;
  const code = /^[A-Z]{3}$/;
  if (typeof own === 'string' && code.test(own)) return own;
  const target = (b: { to: unknown }) => b.to as Rec;
  const shown = manifest.bindings.find(
    (b) =>
      'field' in target(b) &&
      (target(b).prop === undefined || target(b).prop === 'value') &&
      typeof b.value === 'string' &&
      exprReferences(b.value).inputs.includes(input),
  );
  const unit = shown
    ? manifest.bindings.find(
        (b) =>
          target(b).prop === 'currencyCode' &&
          JSON.stringify(target(b).field) === JSON.stringify(target(shown).field),
      )
    : undefined;
  if (typeof unit?.value !== 'string') return null;
  if (code.test(unit.value)) return unit.value;
  const ref = /^\{\{\s*([\w-]+)\s*\}\}$/.exec(unit.value)?.[1];
  if (!ref) return null;
  const refSchema = props[ref];
  const found = values[ref] ?? (isRecord(refSchema) ? refSchema.default : undefined);
  return typeof found === 'string' && code.test(found) ? found : null;
}

export const isDateTime = (schema: unknown) =>
  typeOf(schema) === 'string' && isRecord(schema) && schema.format === 'date-time';

/** Does an authored binding put `{{pass.scanCode}}` into a barcode message? */
function scanCodeInBarcode(manifest: TemplateManifest): boolean {
  return (manifest.bindings ?? []).some((b) => {
    const to = b.to as unknown as Rec;
    return (
      'barcode' in to &&
      (to.prop === undefined || to.prop === 'message') &&
      typeof b.value === 'string' &&
      /\{\{\s*pass\.scanCode\s*(?:\|[^}]*)?\}\}/.test(b.value)
    );
  });
}

export type Report = (code: string, message: string, path: string) => void;

export interface ActionContext {
  error: Report;
  warn: Report;
  input: (n: unknown) => unknown;
  manifest: TemplateManifest;
}

export function actionIssues(actions: unknown, ctx: ActionContext): void {
  const { error, warn } = ctx;
  if (!Array.isArray(actions) || actions.length === 0) {
    error('SCAN_SHAPE', 'scan.actions needs 1 to 6 actions.', 'scan.actions');
    return;
  }
  if (actions.length > MAX_ACTIONS)
    error('SCAN_TOO_MANY', `At most ${MAX_ACTIONS} actions.`, 'scan.actions');
  const ids = new Set<string>();
  const labels = new Set<string>();
  let usesUp = false;
  for (const [i, a] of actions.entries()) {
    const path = `scan.actions.${i}`;
    if (!isRecord(a)) {
      error('SCAN_SHAPE', 'An action must be an object.', path);
      continue;
    }
    for (const key of Object.keys(a))
      if (!ACTION_KEYS.has(key))
        error('SCAN_SHAPE', `${key} is not an action setting.`, `${path}.${key}`);
    if (typeof a.id !== 'string' || !ID.test(a.id))
      error(
        'SCAN_ID_INVALID',
        'An action id is lower-case letters, digits and _, up to 32.',
        `${path}.id`,
      );
    else if (ids.has(a.id))
      error('SCAN_ID_DUPLICATE', `Action id "${a.id}" is used twice.`, `${path}.id`);
    else ids.add(a.id);
    if (!label(a.label))
      error(
        'SCAN_LABEL_INVALID',
        `An action label is 1 to ${MAX_LABEL} characters.`,
        `${path}.label`,
      );
    else {
      const key = a.label.trim().toLowerCase();
      if (labels.has(key))
        error('SCAN_LABEL_DUPLICATE', `Label "${a.label}" is used twice.`, `${path}.label`);
      labels.add(key);
    }
    if (typeof a.kind !== 'string' || !KINDS.has(a.kind)) {
      error('SCAN_SHAPE', 'kind must be check_in, add, take, set or use_up.', `${path}.kind`);
      continue;
    }
    if (a.repeat !== undefined && !(typeof a.repeat === 'string' && REPEATS.has(a.repeat)))
      error('SCAN_SHAPE', 'repeat must be once, daily, cooldown or always.', `${path}.repeat`);
    if (a.minRole !== undefined && !(typeof a.minRole === 'string' && ROLES.has(a.minRole)))
      error('SCAN_SHAPE', 'minRole must be door, desk or manager.', `${path}.minRole`);
    for (const key of BOOLEAN_KEYS)
      if (a[key] !== undefined && typeof a[key] !== 'boolean')
        error('SCAN_SHAPE', `${key} must be true or false.`, `${path}.${key}`);
    if (
      a.cooldownMinutes !== undefined &&
      !(
        isInt(a.cooldownMinutes) &&
        a.cooldownMinutes >= 1 &&
        a.cooldownMinutes <= MAX_COOLDOWN_MINUTES
      )
    )
      error(
        'SCAN_WAIT_RANGE',
        `cooldownMinutes must be 1 to ${MAX_COOLDOWN_MINUTES}.`,
        `${path}.cooldownMinutes`,
      );
    if (a.kind !== 'add' && a.kind !== 'take')
      for (const key of ['amount', 'confirmAbove'] as const)
        if (a[key] !== undefined)
          error('SCAN_SHAPE', `${key} only applies to add and take.`, `${path}.${key}`);
    if (a.kind !== 'set' && a.value !== undefined)
      error('SCAN_SHAPE', 'value only applies to set.', `${path}.value`);
    if (a.kind !== 'take' && a.rewardLabel !== undefined)
      error('SCAN_SHAPE', 'rewardLabel only applies to take.', `${path}.rewardLabel`);
    if (a.kind === 'take' && a.rewardLabel !== undefined && !label(a.rewardLabel))
      error(
        'SCAN_LABEL_INVALID',
        `rewardLabel is 1 to ${MAX_LABEL} characters.`,
        `${path}.rewardLabel`,
      );
    // A stamp card alerts once per card by itself (STAMPS_CHATTY): its adds may notify.
    if (a.kind === 'add' && a.notify === true && a.input !== ctx.manifest.stamps?.input)
      warn(
        'SCAN_NOTIFY_BUDGET',
        'Notifying on every add spends the daily push budget.',
        `${path}.notify`,
      );
    if (a.kind === 'use_up') usesUp = true;
    kindIssues(a, path, ctx);
  }
  if (usesUp && !scanCodeInBarcode(ctx.manifest))
    warn(
      'SCAN_CODE_NOT_IN_BARCODE',
      'Use up needs the barcode to be {{pass.scanCode}}, or scanners cannot tell passes apart.',
      'scan.actions',
    );
}

function kindIssues(a: Rec, path: string, ctx: ActionContext): void {
  const { error } = ctx;
  const schema = ctx.input(a.input);
  const type = typeOf(schema);
  if (a.kind === 'add' || a.kind === 'take') {
    if (schema === undefined) {
      error('SCAN_INPUT_MISSING', `${String(a.kind)} needs a number input.`, `${path}.input`);
      return;
    }
    if (type !== 'number' && type !== 'integer') {
      error(
        'SCAN_INPUT_NOT_NUMBER',
        `Input "${String(a.input)}" is not a number.`,
        `${path}.input`,
      );
      return;
    }
    const digits = isCurrencyInput(schema)
      ? minorDigits(currencyOf(ctx.manifest, String(a.input)))
      : null;
    amountIssues(a, path, schema as Rec, error, digits);
    return;
  }
  if (a.kind === 'set') {
    if (schema === undefined || !['string', 'number', 'integer', 'boolean'].includes(type ?? '')) {
      error('SCAN_INPUT_MISSING', 'set needs a single-value input.', `${path}.input`);
      return;
    }
    if (a.value !== undefined) {
      const ok = new Validator(schemaFor(schema, a.value), '2020-12', false).validate(
        a.value as Json,
      ).valid;
      if (!ok) error('SCAN_VALUE_INVALID', 'value does not fit the input.', `${path}.value`);
    }
    return;
  }
  if (a.kind === 'check_in' && a.input !== undefined) {
    if (schema === undefined)
      error('SCAN_INPUT_MISSING', `Input "${String(a.input)}" does not exist.`, `${path}.input`);
    else if (type !== 'number' && type !== 'integer' && !isDateTime(schema))
      error(
        'SCAN_INPUT_NOT_NUMBER',
        'A check-in records a number or a date-time.',
        `${path}.input`,
      );
  }
}

/** `digits` is the currency's minor digits for a money input, else null (whole or plain numbers). */
function amountIssues(
  a: Rec,
  path: string,
  schema: Rec,
  error: Report,
  digits: number | null,
): void {
  const integer = schema.type === 'integer';
  const cap = isNum(schema.maximum) ? Math.min(schema.maximum, MAX_AMOUNT) : MAX_AMOUNT;
  const low = digits === null ? 1 : 10 ** -digits;
  const fits = (v: unknown, hi = cap): v is number =>
    isNum(v) &&
    v >= low - 1e-9 &&
    v <= hi &&
    (!integer || Number.isInteger(v)) &&
    (digits === null || toMinor(v, digits) !== null);
  const from = digits === null ? '1' : low.toFixed(digits);
  const bad = (message: string, where: string) =>
    error('SCAN_AMOUNT_RANGE', message, `${path}.${where}`);
  const amount = a.amount;
  if (amount !== undefined) {
    if (isRecord(amount)) {
      if (!fits(amount.max)) bad(`amount.max must be ${from} to ${cap}.`, 'amount.max');
      const hi = fits(amount.max) ? amount.max : cap;
      if (amount.default !== undefined && !fits(amount.default, hi))
        bad(`amount.default must be ${from} to ${hi}.`, 'amount.default');
      if (amount.presets !== undefined) {
        const ok =
          Array.isArray(amount.presets) &&
          amount.presets.length <= 6 &&
          amount.presets.every((p) => fits(p, hi));
        if (!ok)
          bad(`amount.presets must be up to 6 values from ${from} to ${hi}.`, 'amount.presets');
      }
    } else if (!fits(amount)) bad(`amount must be ${from} to ${cap}.`, 'amount');
  }
  if (a.confirmAbove !== undefined && !(isNum(a.confirmAbove) && a.confirmAbove >= 0))
    bad('confirmAbove must be 0 or more.', 'confirmAbove');
}
