import type { RulePausedCode } from '../contracts/message-rules.ts';

interface RuleSummaryInput {
  anchorLabel: string;
  offset: { amount: number; unit: 'day' | 'hour'; when: 'before' | 'after' };
  yearly: boolean;
  sendAt: string;
}

/** Words shared by the editor and the rules list. */
export const RULE_COPY = {
  hoursNeedDateTime: 'Hours work only with date and time inputs.',
  yearlyNeedsDate: 'Every year works with a date input.',
  nobodyDue: 'No passes are due in the next 14 days.',
  sendAtRange: 'Pick a time between 08:00 and 20:30.',
  stale: 'Someone else saved this message.',
  paused: {
    RULE_CREATOR_REVOKED: 'Paused. The person who saved it lost access. Save it again to resume.',
    RULE_INPUT_MISSING: 'Paused. A template no longer has the date or message field.',
    RULE_TARGET_INVALID:
      'Paused. A condition uses a time zone that no longer exists. Pick another.',
    ORG_INACTIVE: 'Paused. The organization is inactive.',
  } satisfies Record<RulePausedCode, string>,
} as const;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "7 days before Expiry at 10:00" / "1 hour before Starts at" / "Every year on Birthday at 10:00". */
export function ruleSummary(rule: RuleSummaryInput): string {
  const { amount, unit, when } = rule.offset;
  const time = unit === 'day' ? ` at ${rule.sendAt}` : '';
  if (rule.yearly && amount === 0) return `Every year on ${rule.anchorLabel}${time}`;
  const span = plural(amount, unit);
  const rel = amount === 0 ? 'On' : `${span} ${when}`;
  return `${rel} ${rule.anchorLabel}${time}${rule.yearly ? ', every year' : ''}`.trim();
}

/** The count line for passes a rule did not reach. */
export function missedLine(missed: number): string {
  return missed === 0 ? 'None missed' : `${plural(missed, 'pass')} missed`;
}
