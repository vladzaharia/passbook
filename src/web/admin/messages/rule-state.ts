import type { InputMatch } from '@/shared/contracts/broadcasts.ts';
import {
  type MessageRuleBody,
  type MessageRuleDto,
  RulePreviewBodySchema,
} from '@/shared/contracts/message-rules.ts';
import { DEFAULT_TIME_ZONE } from '@/shared/time-zone.ts';
import type { FieldDef } from '../passes/schema-form/index.ts';
import { CLEAR_CHOICES } from './labels.ts';

/** One condition. Which fields count depends on the input's kind. */
export interface Clause {
  input: string;
  values: string[];
  min: string;
  max: string;
  from: string;
  to: string;
}

export interface RuleState {
  name: string;
  templateIds: string[];
  match: Clause[];
  /** An input key, or `lastScan`. */
  anchor: string;
  amount: number | null;
  unit: 'day' | 'hour';
  when: 'before' | 'after';
  yearly: boolean;
  sendAt: string;
  timeZone: string;
  message: string;
  clear: string;
  on: boolean;
}

export const LAST_SCAN = 'lastScan';
export const MAX_CLAUSES = 3;

export const emptyClause = (input = ''): Clause => ({
  input,
  values: [],
  min: '',
  max: '',
  from: '',
  to: '',
});

export const INITIAL_RULE: RuleState = {
  name: '',
  templateIds: [],
  match: [],
  anchor: '',
  amount: 7,
  unit: 'day',
  when: 'before',
  yearly: false,
  sendAt: '10:00',
  timeZone: '',
  message: '',
  clear: '7d',
  on: true,
};

/** "renewsOn" -> "Renews on": the input's key, as a label. */
export function keyLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const anchorLabel = (rule: Pick<MessageRuleDto, 'anchor'>): string =>
  rule.anchor.kind === 'lastScan' ? 'the last scan' : keyLabel(rule.anchor.input);

const clearValue = (ms: number | null) =>
  CLEAR_CHOICES.find((c) => c.ms === ms)?.value ?? INITIAL_RULE.clear;

const text = (n: number | undefined) => (n === undefined ? '' : String(n));

export function stateOfRule(rule: MessageRuleDto): RuleState {
  return {
    name: rule.name,
    templateIds: rule.templateIds,
    match: (rule.match ?? []).map((c) => ({
      ...emptyClause(c.input),
      values: 'values' in c ? c.values : [],
      min: 'min' in c ? text(c.min) : '',
      max: 'max' in c ? text(c.max) : '',
      from: 'from' in c ? (c.from ?? '') : '',
      to: 'to' in c ? (c.to ?? '') : '',
    })),
    anchor: rule.anchor.kind === 'lastScan' ? LAST_SCAN : rule.anchor.input,
    amount: rule.offset.amount,
    unit: rule.offset.unit,
    when: rule.offset.when,
    yearly: rule.yearly,
    sendAt: rule.sendAt,
    timeZone: rule.timeZone,
    message: rule.message,
    clear: clearValue(rule.clearAfter),
    on: rule.state === 'on',
  };
}

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

/** Null while the condition is unfinished. */
function clauseOf(c: Clause, f: FieldDef | undefined, zone: string): InputMatch[number] | null {
  if (!c.input || !f) return null;
  if (f.widget === 'number') {
    const min = num(c.min);
    const max = num(c.max);
    return min === undefined && max === undefined
      ? null
      : {
          input: c.input,
          ...(min === undefined ? {} : { min }),
          ...(max === undefined ? {} : { max }),
        };
  }
  if (f.widget === 'date' || f.widget === 'datetime') {
    if (!c.from && !c.to) return null;
    return {
      input: c.input,
      ...(c.from ? { from: c.from } : {}),
      ...(c.to ? { to: c.to } : {}),
      timeZone: zone,
    };
  }
  return c.values.length === 0 ? null : { input: c.input, values: c.values };
}

export function matchOf(
  state: RuleState,
  fields: ReadonlyMap<string, FieldDef>,
): { match: InputMatch | undefined; unfinished: boolean } {
  const zone = state.timeZone || DEFAULT_TIME_ZONE;
  const made = state.match.map((c) => clauseOf(c, fields.get(c.input), zone));
  const match = made.filter((c): c is InputMatch[number] => c !== null);
  return { match: match.length ? match : undefined, unfinished: made.some((c) => c === null) };
}

/** The body to preview and save; undefined until every required part is there. */
export function bodyOf(
  orgId: string,
  state: RuleState,
  fields: ReadonlyMap<string, FieldDef>,
): { body: MessageRuleBody | undefined; errors: Partial<Record<RuleField, string>> } {
  const errors: Partial<Record<RuleField, string>> = {};
  const { match, unfinished } = matchOf(state, fields);
  if (!state.name.trim()) errors.name = 'Name it.';
  if (state.templateIds.length === 0) errors.templates = 'Choose at least one template.';
  if (!state.anchor) errors.anchor = 'Choose what to count from.';
  if (state.amount === null || state.amount < 0) errors.offset = 'Enter a number of days or hours.';
  if (!state.message.trim()) errors.message = 'Write a message.';
  if (unfinished) errors.match = 'Finish or remove the condition.';
  const candidate = {
    orgId,
    name: state.name.trim(),
    templateIds: state.templateIds,
    ...(match ? { match } : {}),
    anchor:
      state.anchor === LAST_SCAN
        ? { kind: 'lastScan' as const }
        : { kind: 'input' as const, input: state.anchor },
    offset: { amount: state.amount ?? 0, unit: state.unit, when: state.when },
    yearly: state.yearly,
    sendAt: state.sendAt,
    timeZone: state.timeZone || DEFAULT_TIME_ZONE,
    message: state.message.trim(),
    clearAfter: CLEAR_CHOICES.find((c) => c.value === state.clear)?.ms ?? null,
    on: state.on,
  };
  const parsed = RulePreviewBodySchema.safeParse(candidate);
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const raw = String(issue.path[0]);
      const key = (raw === 'templateIds' ? 'templates' : raw) as RuleField;
      if (RULE_FIELDS.includes(key) && !errors[key]) errors[key] = issue.message;
    }
  return {
    body: Object.keys(errors).length === 0 ? (candidate as MessageRuleBody) : undefined,
    errors,
  };
}

const RULE_FIELDS = [
  'name',
  'templates',
  'anchor',
  'offset',
  'message',
  'match',
  'sendAt',
  'yearly',
] as const;
export type RuleField = (typeof RULE_FIELDS)[number];
