import { moneyText, sanitized } from '../../../passkit/template/scan-display/format.ts';
import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { CUSTOMER_COPY } from '../../../shared/copy/scan-customer.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { LiveRingRow } from './live-ring.ts';

type Receipt = NonNullable<LiveRingRow['receipt']>;

const LOCALE = 'en';
export const fill = (text: string, values: Record<string, string>) =>
  text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
export const clip = (text: string) => sanitized(text, 40);

const PLURAL = new Intl.PluralRules('en');

/**
 * What the customer screen says once a value scan has committed, from the committed outcome and never
 * from the client. Null for a scan that changed no value (a check-in): the screen keeps its system words.
 */
export function receiptOf(
  out: Pick<ScanOutcome, 'kind' | 'action' | 'value'>,
  actions: readonly ResolvedScanAction[],
  /** The template's stamp-count input: its unit is stamp(s). Any other counter reads under its own label. */
  stampsInput: string | null = null,
): Receipt | null {
  const { action, value } = out;
  if (out.kind !== 'ok' || !action) return null;
  if (action.kind === 'use_up') return { headline: CUSTOMER_COPY.redeemed, sub: null };
  if (action.kind === 'set') return { headline: CUSTOMER_COPY.updated, sub: null };
  if (action.kind === 'check_in') return null;
  const reward = actions.find((a) => a.id === action.id)?.rewardLabel;
  if (action.kind === 'take' && reward)
    return { headline: CUSTOMER_COPY.reward, sub: clip(reward) };
  if (!value) return null;
  const { before, after } = value;
  const money = value.format === 'currency';
  if (typeof after !== 'number') return null;
  const moved =
    typeof before === 'number' ? Math.round(Math.abs(after - before) * 1e8) / 1e8 : null;
  if (money) {
    if (moved === null) return null;
    const amount = moneyText(moved, LOCALE, value.currency);
    return {
      headline: clip(
        fill(action.kind === 'take' ? CUSTOMER_COPY.paid : CUSTOMER_COPY.added, { amount }),
      ),
      sub: clip(fill(CUSTOMER_COPY.balance, { balance: moneyText(after, LOCALE, value.currency) })),
      balance: true,
    };
  }
  if (action.kind === 'take') return { headline: CUSTOMER_COPY.redeemed, sub: null };
  if (moved === null) return null;
  return {
    headline: clip(
      value.input === stampsInput
        ? fill(CUSTOMER_COPY.plusStamps[PLURAL.select(moved) as 'one' | 'other'], {
            n: String(moved),
          })
        : fill(CUSTOMER_COPY.plus, { n: String(moved), label: value.label }),
    ),
    sub:
      value.goal === null
        ? null
        : clip(fill(CUSTOMER_COPY.ofGoal, { n: String(after), goal: String(value.goal) })),
  };
}
