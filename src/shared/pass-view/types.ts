import type { ImageSlot, PassStyle } from '../../passkit/types.ts';

/** `ios27` honours posterGeneric and poster event tickets; `legacy` is iOS 26 and earlier. */
export type PassTarget = 'ios27' | 'legacy';

export interface Segment {
  text: string;
  href?: string;
}

export type FieldAlign = 'left' | 'center' | 'right' | 'natural';

export interface FieldView {
  key: string;
  label?: string;
  /** Plain formatted value, also the fallback when `segments` is empty. */
  text: string;
  segments: Segment[];
  align: FieldAlign;
  /** ISO value when the field is a date, for `<time dateTime>`. */
  dateTime?: string;
}

export interface BarcodeView {
  format: string;
  /** bwip-js symbology id. */
  bcid: string;
  message: string;
  altText?: string;
  square: boolean;
}

export interface ImageView {
  slot: ImageSlot;
  src: string;
  srcset?: string;
}

export interface ActionView {
  identifier: string;
  type: string;
  label: string;
  href?: string;
}

export interface TransitView {
  kind: 'air' | 'boat' | 'bus' | 'train' | 'generic';
  label: string;
}

export interface ColorsView {
  background: string;
  foreground: string;
  label: string;
  strip?: string;
  footerBackground?: string;
  /** Background is dark: use light chrome on top. */
  dark: boolean;
}

/** What Wallet draws from `semantics` on iOS 27 poster event tickets and semantic boarding passes. */
export type SemanticView =
  | {
      kind: 'event';
      title?: string;
      date?: string;
      venue?: string;
      seats?: string;
      admission?: string;
    }
  | {
      kind: 'flight';
      from?: string;
      fromName?: string;
      to?: string;
      toName?: string;
      departs?: string;
      arrives?: string;
      gate?: string;
      seat?: string;
      flight?: string;
    };

/** One row of Wallet's upcoming events list. */
export interface UpcomingView {
  id: string;
  name: string;
  venue?: string;
  /** The event is on now. */
  active: boolean;
  /** False when the date is not set or not announced. */
  dated: boolean;
  /** ISO value for `<time dateTime>`; only when dated. */
  dateTime?: string;
  month?: string;
  day?: string;
  /** Weekday and time, or "Date to be announced". */
  when: string;
}

export interface LayoutView {
  target: PassTarget;
  style: PassStyle;
  /** Poster event ticket (eventTicket drawn with the poster layout). */
  poster: boolean;
  /** The pass has no style this target can draw; fields were taken from posterGeneric. */
  degraded: boolean;
  header: FieldView[];
  primary: FieldView[];
  secondary: FieldView[];
  /** Auxiliary fields by row; one row except eventTicket with `row: 1`. */
  auxiliary: FieldView[][];
  footer: FieldView[];
  back: FieldView[];
  additionalInfo: FieldView[];
  /** Front fields past the style's display limit; Wallet lists them in details. */
  overflow: FieldView[];
  barcode?: BarcodeView;
  actions: ActionView[];
  transit?: TransitView;
  /** Semantic layout (poster event ticket, semantic boarding pass); fields are the fallback. */
  semantic?: SemanticView;
  /** Our drawing approximates Wallet's (semantic layouts): show "Approximate". */
  approximate: boolean;
}

export interface PassView {
  style: PassStyle;
  target: PassTarget;
  layout: LayoutView;
  layouts: Record<PassTarget, LayoutView>;
  /** True when the two layouts differ, i.e. a UI toggle is meaningful. */
  hasAlternate: boolean;
  organizationName: string;
  description: string;
  logoText?: string;
  eventLogoText?: string;
  colors: ColorsView;
  images: Partial<Record<ImageSlot, ImageView>>;
  /** Events from `upcomingPassInformation`, in the pass's order. */
  upcoming: UpcomingView[];
  voided: boolean;
  expired: boolean;
  invalid: 'voided' | 'expired' | null;
  suppressHeaderDarkening: boolean;
  locations: { latitude: number; longitude: number; relevantText?: string }[];
  relevantDate?: string;
  locale: string;
  /** Stable codes for values that could not be formatted as declared. */
  warnings: string[];
}
