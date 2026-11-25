/** Shared passkit types. No Cloudflare or Hono imports: this module runs in Node and in Workers. */
import type { PassJson } from './schema/pass-types.ts';
import type { PaperManifest } from './template/paper.ts';
import type { ScanCheckIn } from './template/scan-check-in.ts';
import type { ScanDisplayDoc } from './template/scan-display/schema.ts';
import type { WalletsManifest } from './template/wallets/schema.ts';
import type { CounterManifest } from './types-counters.ts';

export type * from './schema/pass-types.ts';
export type * from './schema/semantic-types.ts';
export type { CounterManifest } from './types-counters.ts';

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

/** Template-authored names and numbers an issue's message mentions. Never personal data. */
export type IssueParams = Record<string, string>;

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
  /** Values the message names, for words that do not parse it (scan display issues). */
  params?: IssueParams;
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

/** An asset known only by name and metadata (bytes are opened lazily from static assets or R2). */
export interface AssetEntry {
  name: string;
  /** `source` is stamp art: kept in the version, never shipped. */
  slot: ImageSlot | 'strings' | 'other' | 'source';
  scale: 1 | 2 | 3;
  locale?: string;
  /** A generated strip: the stamp count it draws. Only the pass's own count ships. */
  stamps?: number;
  /** A per-pass file that replaces the template's file of the same name. */
  override?: boolean;
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
  /** May change a connection-owned input. A scan takes the field over from the connection: it becomes manual and later syncs leave it alone. Default false. */
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
  lookup?: { input: string; public?: boolean };
  window?: { from?: string; until?: string; earlyMinutes?: number; lateMinutes?: number };
  flags?: { input: string; label: string; equals?: string[]; stop?: boolean }[];
  /** The result screen. No display means `defaultScanDisplay` at read, never persisted. */
  display?: ScanDisplayDoc;
  /** An Access card: plans and zones decide the verdict. Every check-in repeats. */
  access?: AccessManifest;
  /** The weakest tag that may be bound to or admit on this pass (absent: `basic`), and the uses it takes (absent: any). */
  tags?: { min?: 'basic' | 'secure'; uses?: ('member' | 'staff' | 'visitor')[] };
  checkIn?: ScanCheckIn;
}

/** A card that fills a strip with stamps; the compositor draws one strip pair per count at save. */
export interface StampsManifest {
  /** The integer input that holds the count. */
  input: string;
  /** Stamps for one reward, 3 to 20. */
  goal: number;
  art: { filled: string; empty: string; reward?: string; rewardEarned?: string };
  /** Each position keeps its own angle. Default true. */
  tilt?: boolean;
  /**
   * Set by a save that raises the goal: cards that were ready at the old goal move up by the
   * difference when their pass moves to this version, so they stay ready.
   */
  keepReady?: boolean;
}

export interface NfcManifest {
  enabled: boolean;
  requiresAuthentication?: boolean;
}

/** The gallery's jobs, in order. A blueprint names one in `display.group`. */
export const BLUEPRINT_GROUPS = ['get-in', 'save-spend', 'membership-id', 'prove-collect'] as const;
export type BlueprintGroup = (typeof BLUEPRINT_GROUPS)[number];

export interface TemplateManifest {
  schema: 1;
  name: string;
  description?: string;
  inputs: JsonSchemaObject;
  sample: Record<string, Json>;
  lookups?: Record<string, Record<string, Record<string, Json>>>;
  bindings: Binding[];
  /** `icon` is a curated icon id (`SCAN_ICONS`): a blueprint's glyph. */
  display: {
    title: Expr;
    subtitle?: Expr;
    status?: Expr;
    search?: string[];
    icon?: string;
    /** A blueprint's gallery group. Additive and optional, so the schema version stays 1. */
    group?: BlueprintGroup;
    /** Words the gallery search also matches ("gift", "punch card"). */
    aliases?: string[];
  };
  behaviors?: { use: string; version: number; config: Json }[];
  requires?: { styles?: PassStyle[]; nfc?: boolean };
  /** Baked templates belong to an org by slug; starters have none. */
  org?: { slug: string; name: string };
  /** Baked only: a platform design to start from. Never issues passes; "Use blueprint" makes a template. */
  blueprint?: boolean;
  /** Files used for web previews only. They never enter the signed bundle. */
  previewOnlyAssets?: string[];
  /** Opts in to broadcast messages: `input` is a back field whose changeMessage is "%@". */
  messaging?: { input: string };
  /** `unique`: at most one pass per externalId for this template, per org and mode. */
  externalId?: { unique?: boolean };
  /** Pass email settings. `subject` is an expression over the inputs: the email's subject line. */
  email?: { subject?: Expr };
  /** What a scanner may do with this template's passes, and what its result screen says. */
  scan?: ScanManifest;
  /** Apple NFC (VAS). Off until the pass type is approved. */
  nfc?: NfcManifest;
  /** Stamp card: the goal, the art and the count input. */
  stamps?: StampsManifest;
  /** Counters by id (lower-case letters, digits, _; up to 4): "7 left", refilled at the scanner. */
  counters?: Record<string, CounterManifest>;
  /** Cross-wallet extras (roles, types, art). Never read by the Apple build. */
  wallets?: WalletsManifest;
  /** Printed ticket layout (size, barcode, fields, terms). Absent: derived from the roles. */
  paper?: PaperManifest;
  channels?: Partial<Record<string, 'on' | 'off'>>;
  brand?: Partial<Record<'colors' | 'logo' | 'icon', 'org' | 'template'>>;
}

export type Personalization = Record<string, Json>;

export interface BehaviorContext {
  now: Date;
  /** The org's zone, for behaviors whose template names none. */
  timeZone?: string;
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
