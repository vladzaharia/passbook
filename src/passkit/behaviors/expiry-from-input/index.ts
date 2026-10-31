import type { BehaviorPlugin, JsonSchemaObject } from '../../types.ts';

export interface ExpiryFromInputConfig {
  /** Input holding an ISO 8601 date-time. */
  input: string;
  /** Minutes added to the input (negative expires earlier). */
  offsetMinutes?: number;
  /** Expires this many days after build time when the input is empty. Omit to never expire. */
  fallbackDays?: number;
  /** Also set `voided` when the expiry is already in the past. */
  voidWhenPast?: boolean;
}

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['input'],
  additionalProperties: false,
  properties: {
    input: { type: 'string', minLength: 1 },
    offsetMinutes: { type: 'integer', minimum: -525600, maximum: 525600 },
    fallbackDays: { type: 'integer', minimum: 1, maximum: 3650 },
    voidWhenPast: { type: 'boolean' },
  },
};

const MINUTE = 60_000;
const DAY = 86_400_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const expiryFromInput: BehaviorPlugin<ExpiryFromInputConfig> = {
  id: 'expiry-from-input',
  version: 1,
  configSchema,
  apply(pass, input, config, ctx) {
    const raw = input[config.input];
    let at: number | undefined;
    if (typeof raw === 'string' && raw !== '') {
      const parsed = Date.parse(raw);
      if (Number.isNaN(parsed)) throw new Error(`${config.input} is not a date.`);
      at = parsed + (config.offsetMinutes ?? 0) * MINUTE;
    } else if (config.fallbackDays !== undefined) {
      at = ctx.now.getTime() + config.fallbackDays * DAY;
    }
    if (at === undefined) {
      delete pass.expirationDate;
      return;
    }
    pass.expirationDate = iso(at);
    if (config.voidWhenPast && at <= ctx.now.getTime()) pass.voided = true;
  },
};

export default expiryFromInput;
