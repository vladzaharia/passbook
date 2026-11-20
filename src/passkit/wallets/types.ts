/** Shapes of the cross-wallet core: the view, compilers and the fidelity report (architecture 2 to 4). */

import type { WalletsManifest } from '../template/wallets/schema.ts';
import type { Json, PassBeacon, PassLocation, PassStyle, SemanticTags } from '../types.ts';
import type {
  BarcodeKind,
  CapabilityId,
  Support,
  ViewGroup,
  WalletRole,
  WalletTarget,
} from './vocab.ts';

export * from './vocab.ts';

// The view

export type ViewLinkKind = 'tel' | 'mailto' | 'web' | 'other';
export interface ViewLink {
  kind: ViewLinkKind;
  url: string;
  text?: string;
}

export interface ViewField {
  group: ViewGroup;
  key: string;
  /** `backFields.terms`: group dictionary key and field key. Fidelity paths and `omit` use it. */
  path: string;
  /** Front-to-back position over all groups. */
  order: number;
  label?: string;
  value: Json;
  /** The value as display text. Null is empty; objects are JSON. */
  text: string;
  /** `attributedValue` links, in order. */
  links: ViewLink[];
  dateStyle?: string;
  timeStyle?: string;
  numberStyle?: string;
  currencyCode?: string;
  changeMessage?: string;
  semantics?: SemanticTags;
}

export type RoleScalar =
  | { kind: 'text'; text: string }
  | { kind: 'date'; iso: string }
  | { kind: 'location'; latitude: number; longitude: number }
  | { kind: 'number'; number: number; text: string }
  | { kind: 'money'; amount: string; currencyCode: string }
  | { kind: 'channel'; channel: 'online' | 'instore' | 'both' }
  | { kind: 'url'; url: string }
  | { kind: 'app'; name?: string; url?: string; logo?: string }
  | { kind: 'links'; links: ViewLink[] };

export type RoleSource = 'manifest' | 'semantics' | 'style';
export type RoleValue = RoleScalar & {
  source: RoleSource;
  /** The label of the field that supplied the value. */
  label?: string;
  /** Paths of the Apple fields the value came from: a compiler skips them as plain text. */
  fields: string[];
};
export type ResolvedRoles = Partial<Record<WalletRole, RoleValue>>;

export interface ViewBarcode {
  format: string;
  kind: BarcodeKind | 'other';
  message: string;
  encoding: string;
  altText?: string;
}

export interface ViewImageFile {
  name: string;
  slot: string;
  scale: 1 | 2 | 3;
  locale?: string;
  width?: number;
  height?: number;
  /** A per-pass file (member photo, override). Never sent to a provider. */
  personal: boolean;
  /** Public URL from the context's resolver. Never set on a personal file. */
  url?: string;
}

export interface ViewImages {
  /** The Apple art by slot, best scale first. */
  apple: Record<string, ViewImageFile[]>;
  /** `wallets/<target>/` art by `wallets.<target>.images` slot. */
  overrides: Partial<Record<WalletTarget, Record<string, ViewImageFile>>>;
}

export interface ViewRelevance {
  dates: { start?: string; end?: string }[];
  locations: PassLocation[];
  beacons: PassBeacon[];
  maxDistance?: number;
}

export interface ViewEvent {
  identifier: string;
  name: string;
  date?: string;
  active: boolean;
}

export type ViewNoteCode =
  | 'ROLE_EMPTY'
  | 'ROLE_EXPR_FAILED'
  | 'ROLE_FIELD_MISSING'
  | 'ROLE_VALUE_INVALID'
  | 'ART_MISSING';

/** A problem found while building the view. It never stops the view. */
export interface ViewNote {
  code: ViewNoteCode;
  /** A role name or an image path. */
  subject: string;
  message: string;
}

/** The materialized Apple pass in the terms compilers read (architecture 2.1). */
export interface WalletPassView {
  style: PassStyle;
  preferredStyleSchemes: string[];
  org: string;
  description: string;
  logoText?: string;
  fields: ViewField[];
  roles: ResolvedRoles;
  barcodes: ViewBarcode[];
  colors: { background?: string; foreground?: string; label?: string; footerBackground?: string };
  images: ViewImages;
  relevance: ViewRelevance;
  validity: { expirationDate?: string; expired: boolean; voided: boolean };
  links: {
    featuredActions: { identifier: string; type: string; url?: string }[];
    appLaunchURL?: string;
    /** Event guide and service URLs by key. */
    urls: Record<string, string>;
  };
  events: ViewEvent[];
  /** Locale to key to string, for the locales the context asked for. */
  localization: Record<string, Record<string, string>>;
  sharingProhibited: boolean;
  nfc: boolean;
  personalization: boolean;
  messaging: { input?: string; fields: string[] };
  /** The `wallets` block the view was resolved with. */
  wallets?: WalletsManifest;
  notes: ViewNote[];
}

// Compilers and the report

/** What a compiler returns for one view. A compiler lists every capability it did not carry natively. */
export interface FidelityItem {
  capability: CapabilityId;
  /** Field path (`backFields.terms`) or feature path (`barcodes.0`); empty for the whole pass. */
  path: string;
  support: Support;
  message: string;
}

export const BLOCK_CODES = [
  'IDENTITY_TOO_LONG',
  'REQUIRED_ROLE_EMPTY',
  'TYPE_UNSATISFIED',
] as const;
export type BlockCode = (typeof BLOCK_CODES)[number];
/** A pass-level failure: the pass is not offered for this target (architecture 4.2). */
export interface PassBlock {
  code: BlockCode;
  message: string;
}

export interface CompileOptions {
  now: Date;
  /** `<target>.omit` from the manifest: field paths, bare field keys and capability ids. */
  omit: readonly string[];
}

export interface CompileResult {
  /** The provider type that was chosen, after type fallback. */
  type: string;
  items: FidelityItem[];
  blocked?: PassBlock;
  classBody?: unknown;
  objectBody?: unknown;
  cardData?: unknown;
}

export interface WalletCompiler {
  target: WalletTarget;
  /** Joins the release candidate digest. Bump it with any change to compiled output. */
  revision: number;
  compile(view: WalletPassView, options: CompileOptions): CompileResult;
}

export type ItemSeverity = 'difference' | 'omission' | 'blocked';
/**
 * Who notices a loss: `holder` (customers won't see it), `door` (staff scanning), `look` (it looks
 * different) or `absent` (the wallet has no such feature). Only `holder` and `door` need approval.
 */
export interface ReportItem {
  capability: CapabilityId;
  path: string;
  support: Support;
  severity: ItemSeverity;
  group: ItemGroup;
  /** The author listed it in `<target>.omit`. */
  chosen: boolean;
  message: string;
}

export type ReportStatus =
  | { kind: 'off' }
  | { kind: 'ready' }
  | { kind: 'omissions'; count: number }
  | { kind: 'blocked'; reason: string };

export interface FidelityReport {
  schema: 1;
  target: WalletTarget;
  type: string;
  compilerRevision: number;
  status: ReportStatus;
  items: ReportItem[];
}
