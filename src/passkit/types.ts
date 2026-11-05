/** Shared passkit types. No Cloudflare or Hono imports: this module runs in Node and in Workers. */

import type { PassJson } from './schema/pass-types.ts';
import type { ScanDisplayDoc } from './template/scan-display/schema.ts';

export type * from './schema/pass-types.ts';
export type * from './schema/semantic-types.ts';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type PassStyle =
  | 'generic'
  | 'posterGeneric'
  | 'storeCard'
  | 'coupon'
  | 'eventTicket'
  | 'boardingPass';

export const PASS_STYLES: readonly PassStyle[] = [
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
];

export type FieldProp =
  | 'value'
  | 'attributedValue'
  | 'label'
  | 'changeMessage'
  | 'currencyCode'
  | 'numberStyle'
  | 'dateStyle'
  | 'timeStyle'
  | 'textAlignment'
  | 'isRelative'
  | 'ignoresTimeZone';

export type ImageSlot =
  | 'icon'
  | 'logo'
  | 'primaryLogo'
  | 'secondaryLogo'
  | 'strip'
  | 'thumbnail'
  | 'artwork'
  | 'background'
  | 'footer'
  | 'personalizationLogo'
  | 'venueMap';

/** Information about the identity a pass is signed with, used by validatePass. */
export interface PassIdentity {
  passTypeIdentifier: string;
  teamIdentifier: string;
  nfcEnabled?: boolean;
}

/** PEM material for signing. `intermediate` is the Apple WWDR certificate. */
export interface SigningMaterial {
  certificate: string;
  privateKey: string;
  intermediate: string;
}

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

/** An asset known only by name and metadata (bytes are opened lazily from static assets or R2). */
export interface AssetEntry {
  name: string;
  slot: ImageSlot | 'strings' | 'other';
  scale: 1 | 2 | 3;
  locale?: string;
  size: number;
  sha1: string;
  crc32: number;
  width?: number;
  height?: number;
  source: { kind: 'static'; path: string } | { kind: 'r2'; key: string } | { kind: 'inline' };
}

// Template manifest (wallet.template.json)

/** `"{{memberName}}"` interpolation or `{ const }`. No loops or functions. */
export type Expr = string | { const: Json };

export type Target =
  | { field: string | string[]; prop?: FieldProp }
  | { action: string; prop: 'url' | 'placeIdentifier' }
  | { barcode: number | '*'; prop: 'message' | 'altText' }
  | { image: string }
  | { pointer: string };

export type Condition =
  | { input: string; eq?: Json; in?: Json[]; empty?: boolean }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface Binding {
  to: Target;
  value?: Expr;
  when?: Condition;
  remove?: Condition;
  omitIfEmpty?: boolean;
}

export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, Json>;
  required?: string[];
} & {
  [key: string]: Json | undefined;
};

export type {
  ScanChipDoc,
  ScanDisplayDoc,
  ScanPanelDoc,
  ScanPresetId,
  ScanRowDoc,
  ScanText,
} from './template/scan-display/schema.ts';

export type ScanActionKind = 'check_in' | 'add' | 'take' | 'set' | 'use_up';
export type ScanRole = 'door' | 'desk' | 'manager';
export type ScanRepeat = 'once' | 'daily' | 'cooldown' | 'always';

export interface ScanAction {
  /** `^[a-z][a-z0-9_]{0,31}$`, unique. Scans and gates key on it. */
  id: string;
  /** 1-24 characters, unique. */
  label: string;
  kind: ScanActionKind;
  /** add, take: a number input. set: a scalar input. check_in: an optional record input. */
  input?: string;
  /** add, take: fixed, or staff enter 1..max. */
  amount?: number | { max: number; presets?: number[]; default?: number };
  /** set: a fixed value. Absent: staff pick or type one. */
  value?: Json;
  repeat?: ScanRepeat;
  /** repeat `cooldown`: 1-10080. */
  cooldownMinutes?: number;
  minRole?: ScanRole;
  confirm?: boolean;
  confirmAbove?: number;
  /** check_in: Let in again is offered. Default true. */
  allowAgain?: boolean;
  /** take: "Free coffee", 1-24. */
  rewardLabel?: string;
  /** A lock-screen message; spends the push budget. Default false. */
  notify?: boolean;
  /** May change a connection-owned input, which then becomes manual. Default false. */
  allowOnConnected?: boolean;
}

export type AccessDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** `"HH:MM-HH:MM"`, 1-4 per day. An end before the start runs past midnight; `24:00` only as an end. */
export type WeeklyHours = Partial<Record<AccessDay, string[]>>;
export interface AccessGrant {
  /** A zone key, `"*"` (every zone), or an input holding a key. */
  zone: string | { input: string };
  /** Narrows the plan's hours for this zone. */
  hours?: WeeklyHours;
}
export interface AccessPlan {
  /** `^[a-z][a-z0-9_]{0,31}$`; passes store it. */
  id: string;
  /** 1-24 characters. */
  label: string;
  kind: 'always' | 'timed' | 'guest';
  /** Timed: required. Guest: optional. Always: none. */
  hours?: WeeklyHours;
  /** 1-24. */
  zones: AccessGrant[];
  /** Guest: the default visit limit, 1-999. None means unlimited in the window. */
  visits?: number;
  /** Guest: length when the pass has no end, 1-366. */
  days?: number;
}
/** An Access card's plans. Types only in P0; `accessIssues` checks the body later. */
export interface AccessManifest {
  input: {
    plan: string;
    zones?: string;
    from?: string;
    until?: string;
    visits?: string;
    sponsor?: string;
  };
  /** 1-12. */
  plans: AccessPlan[];
  suspend?: { input: string; equals: string[] };
  rules?: { visitGapMinutes?: number; reentryMinutes?: number | null };
}

export interface ScanManifest {
  /** 1-6. */
  actions: ScanAction[];
  /** A typed member, card or ticket number. */
  lookup?: { input: string };
  window?: { from?: string; until?: string; earlyMinutes?: number; lateMinutes?: number };
  flags?: { input: string; label: string; equals?: string[]; stop?: boolean }[];
  /** The result screen. No display means `defaultScanDisplay` at read, never persisted. */
  display?: ScanDisplayDoc;
  /** An Access card: plans and zones decide the verdict. Every check-in repeats. */
  access?: AccessManifest;
}

export interface NfcManifest {
  enabled: boolean;
  requiresAuthentication?: boolean;
}

export interface TemplateManifest {
  schema: 1;
  name: string;
  description?: string;
  inputs: JsonSchemaObject;
  sample: Record<string, Json>;
  lookups?: Record<string, Record<string, Record<string, Json>>>;
  bindings: Binding[];
  display: { title: Expr; subtitle?: Expr; status?: Expr; search?: string[] };
  behaviors?: { use: string; version: number; config: Json }[];
  requires?: { styles?: PassStyle[]; nfc?: boolean };
  /** Baked templates belong to an org by slug; starters have none. */
  org?: { slug: string; name: string };
  /** Files used for web previews only. They never enter the signed bundle. */
  previewOnlyAssets?: string[];
  /**
   * Opts in to broadcast messages: `input` is bound to a back field whose changeMessage is "%@",
   * so a new value shows on the lock screen.
   */
  messaging?: { input: string };
  /** What a scanner may do with this template's passes, and what its result screen says. */
  scan?: ScanManifest;
  /** Apple NFC (VAS). Off until the pass type is approved. */
  nfc?: NfcManifest;
}

export type Personalization = Record<string, Json>;

export interface BehaviorContext {
  now: Date;
  identity: PassIdentity;
  lookups: NonNullable<TemplateManifest['lookups']>;
}

/** Trusted build-time plugin. Templates reference it by id and supply config. */
export interface BehaviorPlugin<C = unknown> {
  id: string;
  version: number;
  configSchema: JsonSchemaObject;
  apply(pass: PassJson, input: Personalization, config: C, ctx: BehaviorContext): void;
}
