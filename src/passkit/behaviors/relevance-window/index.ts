import type { BehaviorPlugin, JsonSchemaObject } from '../../types.ts';

export interface RelevanceWindowConfig {
  /** Input holding the start (event start, boarding time) as ISO 8601. */
  start: string;
  /** Input holding the end (event end, arrival). Without it the window lasts `fallbackMinutes`. */
  end?: string;
  /** Minutes before the start that the pass surfaces (doors, check-in). */
  leadMinutes?: number;
  fallbackMinutes?: number;
}

const configSchema: JsonSchemaObject = {
  type: 'object',
  required: ['start'],
  additionalProperties: false,
  properties: {
    start: { type: 'string', minLength: 1 },
    end: { type: 'string', minLength: 1 },
    leadMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
    fallbackMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
  },
};

const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function parse(input: Record<string, unknown>, key: string | undefined): number | undefined {
  const raw = key ? input[key] : undefined;
  if (typeof raw !== 'string' || raw === '') return undefined;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`${key} is not a date.`);
  return ms;
}

/**
 * Sets `relevantDates` to one window: from the start minus the lead to the end, so the pass shows
 * on the lock screen while it matters. `relevantDate` keeps the start for older systems.
 */
export const relevanceWindow: BehaviorPlugin<RelevanceWindowConfig> = {
  id: 'relevance-window',
  version: 1,
  configSchema,
  apply(pass, input, config) {
    const start = parse(input, config.start);
    if (start === undefined) {
      delete pass.relevantDates;
      delete pass.relevantDate;
      return;
    }
    const end = parse(input, config.end) ?? start + (config.fallbackMinutes ?? 180) * MINUTE;
    const from = start - (config.leadMinutes ?? 0) * MINUTE;
    // Wallet drops intervals longer than 24 hours, so a long event keeps its first day.
    const until = Math.min(Math.max(end, start), from + DAY);
    pass.relevantDates = [{ startDate: iso(from), endDate: iso(until) }];
    pass.relevantDate = iso(start);
  },
};

export default relevanceWindow;
