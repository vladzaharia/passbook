/**
 * `renderCustomerView` (ST 3.3): the doc, a scope and the outcome's non-secret facts to what a
 * customer screen shows. Pure. The band and lines are the system's; only what `display.customer`
 * names comes from the doc, over a scope with inputs, the scanner and counts removed.
 */
import {
  type ScanCustomerView,
  ScanCustomerViewSchema,
} from '../../../shared/contracts/scan-customer.ts';
import { CUSTOMER_COPY } from '../../../shared/copy/scan-customer.ts';
import { defaultCustomerPanel, rowAllowed } from './customer-issues.ts';
import { sanitized } from './format.ts';
import { renderScanDisplay } from './render.ts';
import { plausibleName } from './render-header.ts';
import type { ScanDisplayDoc } from './schema.ts';
import type { ScanDisplayScope } from './text.ts';

interface CustomerViewBase {
  /** Orders and replaces bodies; never a pass or scan id. */
  ref: string;
  at: number;
  where: string;
  test: boolean;
  locale: string;
  timeZone: string;
  now: number;
  /** The session's setting; the doc's `customer.greet` can also turn it off. Default on. */
  greet?: boolean;
  refusedLine?: string;
  /** The line under the headline; on see_desk only the three access subs (`CUSTOMER_REASON_SUB`). */
  sub?: string | null;
  /** The figure under a review headline (To pay, Adding). */
  figure?: string;
  lines?: ScanCustomerView['lines'];
  milestone?: ScanCustomerView['milestone'];
  /** Fields bound to an `x-scan` input: the customer scope drops them. */
  withheldFields?: readonly string[];
  onError?: (error: unknown) => void;
}

/** ok and review say what happened or what is asked: the caller always names the headline. */
export type CustomerViewOptions =
  | (CustomerViewBase & { screen: 'ok' | 'review'; headline: string })
  | (CustomerViewBase & { screen: 'ready' | 'see_desk'; headline?: undefined });

/** The system headline of an ok body that carries no value receipt. */
export function okHeadline(o: { direction?: 'in' | 'out' | null }): string {
  return o.direction === 'out' ? CUSTOMER_COPY.checkedOut : CUSTOMER_COPY.checkedIn;
}

const omit = <T extends object>(value: T, keys: readonly string[]): T =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k))) as T;

const stripWhere = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stripWhere)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([k]) => k !== 'where')
            .map(([k, v]) => [k, stripWhere(v)]),
        )
      : value;

/** The Door scope minus inputs, the scanner, counts, the external id and where-bearing history. */
export function customerScope(
  scope: ScanDisplayScope,
  withheld: readonly string[] = [],
): ScanDisplayScope {
  const out: ScanDisplayScope = { ...omit(scope, ['inputs', 'scanner', 'occupancy']) };
  const rec = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
  if (rec(out.event))
    out.event = omit(out.event as object, ['arrived', 'expected', 'capacity']) as never;
  if (rec(out.pass)) out.pass = omit(out.pass as object, ['externalId']) as never;
  if (rec(out.fields)) out.fields = omit(out.fields as object, withheld) as never;
  if (out.history !== undefined) out.history = stripWhere(out.history) as never;
  return out;
}

/** The doc cut to what the customer block names, nothing else. */
function customerDoc(doc: ScanDisplayDoc, screen: 'ready' | 'ok'): ScanDisplayDoc {
  const block = doc.customer;
  const chips = new Set(block?.chips ?? []);
  const panelId = block ? (block.panel ?? null) : defaultCustomerPanel(doc);
  const header = (h: ScanDisplayDoc['header']): ScanDisplayDoc['header'] => ({
    chips: (h.chips ?? []).filter((c) => chips.has(c.id) && !c.minRole),
  });
  const panel = (doc.panels ?? []).find((p) => p.id === panelId && !p.minRole);
  const out: ScanDisplayDoc = {
    v: 1,
    ...(doc.holder ? { holder: doc.holder } : {}),
    header: header(doc.header),
  };
  if (doc.currency) out.currency = doc.currency;
  if (doc.variants) out.variants = doc.variants.map((v) => ({ ...v, header: header(v.header) }));
  if (panel) {
    const { minRole: _m, actions: _a, ...rest } = panel;
    out.panels = [
      {
        ...rest,
        on: [screen],
        rows: panel.rows.filter((r) => rowAllowed(r) && !r.minRole),
      },
    ].filter((p) => p.rows.length > 0);
  }
  return out;
}

function band(o: CustomerViewOptions, greet: string | null) {
  const sub = o.sub ?? null;
  if (o.screen === 'ok' || o.screen === 'review') return { headline: o.headline, sub };
  if (o.screen === 'ready') return { headline: greet ?? CUSTOMER_COPY.hello, sub };
  return { headline: o.refusedLine ?? CUSTOMER_COPY.refusedLine, sub };
}

const shell = (o: CustomerViewOptions): ScanCustomerView => ({
  v: 1,
  screen: o.screen,
  ref: o.ref,
  at: o.at,
  where: sanitized(o.where, 40),
  band: band(o, null),
  greet: null,
  chips: [],
  panel: null,
  lines: [],
  milestone: null,
  test: o.test,
});

/** Never throws: any failure is the system view (the band only). */
export function renderCustomerView(
  doc: ScanDisplayDoc | null,
  scope: ScanDisplayScope,
  options: CustomerViewOptions,
): ScanCustomerView {
  const base = shell(options);
  if (options.screen === 'see_desk') return base;
  try {
    // A draft is the ready card with the amount: it shows what ready shows.
    const docScreen = options.screen === 'review' ? 'ready' : options.screen;
    const shown = doc ? customerDoc(doc, docScreen) : null;
    const rendered = shown
      ? renderScanDisplay(shown, customerScope(scope, options.withheldFields), {
          screen: docScreen,
          role: 'door',
          terminal: false,
          locale: options.locale,
          timeZone: options.timeZone,
          now: options.now,
        })
      : null;
    const full = rendered?.identity.holder ?? '';
    const pass = scope.pass as Record<string, unknown> | undefined;
    const real =
      full !== '' && full !== pass?.templateName && full !== 'Pass' && plausibleName(full, 3);
    const greetOn = options.greet !== false && doc?.customer?.greet !== false;
    const first = real ? (full.split(' ')[0] ?? '') : '';
    const greet =
      greetOn && first ? sanitized(CUSTOMER_COPY.greet.replace('{name}', first), 24) : null;
    return ScanCustomerViewSchema.parse({
      ...base,
      band: band(options, greet),
      greet,
      chips: rendered?.header.chips.slice(0, 2) ?? [],
      panel: rendered?.panels[0] ?? null,
      lines: (options.lines ?? []).slice(0, 2),
      milestone: options.milestone ?? null,
      ...(options.figure ? { figure: sanitized(options.figure, 24) } : {}),
    });
  } catch (error) {
    options.onError?.(error);
    return base;
  }
}
