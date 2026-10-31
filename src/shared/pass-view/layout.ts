import type { PassField, PassFields, PassJson, PassStyle } from '../../passkit/types.ts';
import { pickBarcode } from './barcode.ts';
import { type FormatContext, formatValue } from './format.ts';
import { autolink, type Detector, parseAttributed, safeHref } from './sanitize.ts';
import { localize } from './strings.ts';
import type {
  ActionView,
  FieldAlign,
  FieldView,
  LayoutView,
  PassTarget,
  TransitView,
} from './types.ts';

const LEGACY_STYLES = ['boardingPass', 'coupon', 'eventTicket', 'storeCard', 'generic'] as const;

export interface StyleChoice {
  style: PassStyle;
  poster: boolean;
  degraded: boolean;
  fields: PassFields;
}

/** Pick the style Wallet would draw on this target. Undefined when the pass declares none. */
export function chooseStyle(pass: PassJson, target: PassTarget): StyleChoice | undefined {
  const poster = pass.posterGeneric;
  if (target === 'ios27' && poster) {
    return { style: 'posterGeneric', poster: false, degraded: false, fields: poster };
  }
  const legacy = LEGACY_STYLES.find((s) => pass[s] !== undefined);
  if (legacy) {
    const schemes = Array.isArray(pass.preferredStyleSchemes) ? pass.preferredStyleSchemes : [];
    const isPoster =
      target === 'ios27' && legacy === 'eventTicket' && schemes.includes('posterEventTicket');
    return {
      style: legacy,
      poster: isPoster,
      degraded: false,
      fields: pass[legacy] as PassFields,
    };
  }
  if (poster) return { style: 'generic', poster: false, degraded: true, fields: poster };
  return undefined;
}

const ALIGN: Record<string, FieldAlign> = {
  PKTextAlignmentLeft: 'left',
  PKTextAlignmentCenter: 'center',
  PKTextAlignmentRight: 'right',
  PKTextAlignmentNatural: 'natural',
};

export interface FieldContext extends FormatContext {
  strings?: Record<string, string>;
  warnings: Set<string>;
}

function detectors(f: PassField): Set<Detector> {
  const t = f.dataDetectorTypes;
  if (!Array.isArray(t)) return new Set<Detector>(['link', 'phone']);
  const out = new Set<Detector>();
  if (t.includes('PKDataDetectorTypeLink')) out.add('link');
  if (t.includes('PKDataDetectorTypePhoneNumber')) out.add('phone');
  return out;
}

export function toField(f: PassField, ctx: FieldContext, kind: 'back' | 'front'): FieldView {
  const value = typeof f.value === 'string' ? localize(ctx.strings, f.value) : f.value;
  const formatted = formatValue(value, f, ctx);
  if (formatted.warning) ctx.warnings.add(`${formatted.warning}:${f.key}`);
  let segments = [{ text: formatted.text }].filter((s) => s.text);
  let text = formatted.text;
  if (typeof f.attributedValue === 'string') {
    const attributed = parseAttributed(localize(ctx.strings, f.attributedValue));
    if (attributed.length) {
      segments = attributed;
      text = attributed.map((s) => s.text).join('');
    }
  } else if (kind === 'back' && !formatted.dateTime) {
    segments = autolink(text, detectors(f));
  }
  return {
    key: String(f.key),
    ...(typeof f.label === 'string' && f.label ? { label: localize(ctx.strings, f.label) } : {}),
    text,
    segments,
    align: ALIGN[String(f.textAlignment)] ?? 'natural',
    ...(formatted.dateTime ? { dateTime: formatted.dateTime } : {}),
  };
}

const list = (v: unknown): PassField[] =>
  Array.isArray(v)
    ? v.filter((f): f is PassField => !!f && typeof f === 'object' && 'key' in f)
    : [];

const TRANSIT: Record<string, TransitView> = {
  PKTransitTypeAir: { kind: 'air', label: 'Flight' },
  PKTransitTypeBoat: { kind: 'boat', label: 'Boat' },
  PKTransitTypeBus: { kind: 'bus', label: 'Bus' },
  PKTransitTypeTrain: { kind: 'train', label: 'Train' },
  PKTransitTypeGeneric: { kind: 'generic', label: 'Transit' },
};

const ACTION_LABELS: Record<string, string> = {
  viewSchedule: 'View schedule',
  watchTrailer: 'Watch trailer',
  listenToMusic: 'Listen',
  call: 'Call',
  place: 'Directions',
  addToBalance: 'Add to balance',
  order: 'Order',
  shop: 'Shop',
  membershipBenefits: 'Benefits',
  bookAppointment: 'Book appointment',
  bookCar: 'Book car',
  bookFlight: 'Book flight',
  bookStay: 'Book stay',
  viewOffersRewards: 'Offers and rewards',
};

function actions(pass: PassJson): ActionView[] {
  const out: ActionView[] = [];
  for (const a of Array.isArray(pass.featuredActions) ? pass.featuredActions : []) {
    if (out.length === 2) break;
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const { identifier, type, url } = a as Record<string, unknown>;
    if (typeof identifier !== 'string' || typeof type !== 'string') continue;
    const href = typeof url === 'string' ? safeHref(url) : undefined;
    out.push({
      identifier,
      type,
      label: ACTION_LABELS[type] ?? type,
      ...(href ? { href } : {}),
    });
  }
  return out;
}

interface Limits {
  header: number;
  primary: number;
  secondary: number;
  aux: number;
  footer: number;
  /** Secondary and auxiliary share one row of `secondary` fields. */
  merge: boolean;
}

const LIMITS: Record<PassStyle, Limits> = {
  generic: { header: 3, primary: 1, secondary: 4, aux: 4, footer: 0, merge: false },
  storeCard: { header: 3, primary: 1, secondary: 4, aux: 0, footer: 0, merge: true },
  coupon: { header: 3, primary: 1, secondary: 4, aux: 0, footer: 0, merge: true },
  eventTicket: { header: 3, primary: 1, secondary: 4, aux: 4, footer: 0, merge: false },
  boardingPass: { header: 3, primary: 2, secondary: 4, aux: 5, footer: 0, merge: false },
  posterGeneric: { header: 1, primary: 4, secondary: 0, aux: 0, footer: 1, merge: false },
};

export function buildLayout(
  pass: PassJson,
  target: PassTarget,
  choice: StyleChoice,
  ctx: FieldContext,
): LayoutView {
  const { style, fields } = choice;
  const lim = LIMITS[choice.degraded ? 'generic' : style];
  const front = (v: unknown) => list(v).map((f) => toField(f, ctx, 'front'));
  const overflow: FieldView[] = [];
  const take = (all: FieldView[], n: number) => {
    overflow.push(...all.slice(n));
    return all.slice(0, n);
  };
  const header = take(front(fields.headerFields), lim.header);
  const primary = take(front(fields.primaryFields), lim.primary);
  let secondary: FieldView[];
  let auxiliary: FieldView[][];
  const auxRaw = list(fields.auxiliaryFields);
  if (lim.merge) {
    secondary = take(front([...list(fields.secondaryFields), ...auxRaw]), lim.secondary);
    auxiliary = [];
  } else {
    secondary = take(front(fields.secondaryFields), lim.secondary);
    const rows: PassField[][] = [[], []];
    for (const f of auxRaw) rows[style === 'eventTicket' && f.row === 1 ? 1 : 0]?.push(f);
    auxiliary = rows
      .map((r) =>
        take(
          r.map((f) => toField(f, ctx, 'front')),
          lim.aux,
        ),
      )
      .filter((r) => r.length);
  }
  const footer = take(front(fields.footerFields), lim.footer);
  const back = list(fields.backFields).map((f) => toField(f, ctx, 'back'));
  const additionalInfo = list(fields.additionalInfoFields).map((f) => toField(f, ctx, 'back'));
  const transitType = typeof fields.transitType === 'string' ? fields.transitType : undefined;
  const barcode = pickBarcode(pass, target);
  return {
    target,
    style: choice.degraded ? 'generic' : style,
    poster: choice.poster,
    degraded: choice.degraded,
    header,
    primary,
    secondary,
    auxiliary,
    footer,
    back,
    additionalInfo,
    overflow,
    ...(barcode ? { barcode } : {}),
    actions: target === 'ios27' && !choice.poster ? actions(pass) : [],
    ...(style === 'boardingPass'
      ? { transit: TRANSIT[transitType ?? ''] ?? (TRANSIT.PKTransitTypeGeneric as TransitView) }
      : {}),
  };
}
