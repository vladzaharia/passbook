/** Shared passkit types. No Cloudflare or Hono imports: this module runs in Node and in Workers. */

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

export type ImageSlot =
  | 'icon'
  | 'logo'
  | 'primaryLogo'
  | 'secondaryLogo'
  | 'strip'
  | 'thumbnail'
  | 'artwork'
  | 'background'
  | 'footer';

export interface PassField {
  key: string;
  value: Json;
  label?: string;
  attributedValue?: Json;
  changeMessage?: string;
  dataDetectorTypes?: string[];
  textAlignment?: string;
  dateStyle?: string;
  timeStyle?: string;
  numberStyle?: string;
  currencyCode?: string;
  semantics?: Record<string, Json>;
  row?: 0 | 1;
  [key: string]: Json | undefined;
}

export interface PassFields {
  headerFields?: PassField[];
  primaryFields?: PassField[];
  secondaryFields?: PassField[];
  auxiliaryFields?: PassField[];
  backFields?: PassField[];
  additionalInfoFields?: PassField[];
  transitType?: string;
  [key: string]: Json | PassField[] | undefined;
}

export interface PassBarcode {
  format: string;
  message: string;
  messageEncoding: string;
  altText?: string;
}

export interface PassLocation {
  latitude: number;
  longitude: number;
  altitude?: number;
  relevantText?: string;
  maxDistance?: number;
}

/** pass.json. Known keys are typed; anything else is allowed and produces a validator warning. */
export interface PassJson {
  formatVersion: 1;
  passTypeIdentifier: string;
  teamIdentifier: string;
  serialNumber: string;
  organizationName: string;
  description: string;
  webServiceURL?: string;
  authenticationToken?: string;
  logoText?: string;
  foregroundColor?: string;
  backgroundColor?: string;
  labelColor?: string;
  barcodes?: PassBarcode[];
  locations?: PassLocation[];
  relevantDate?: string;
  expirationDate?: string;
  voided?: boolean;
  sharingProhibited?: boolean;
  suppressStripShine?: boolean;
  userInfo?: Json;
  featuredActions?: Json[];
  semantics?: Record<string, Json>;
  generic?: PassFields;
  posterGeneric?: PassFields;
  storeCard?: PassFields;
  coupon?: PassFields;
  eventTicket?: PassFields;
  boardingPass?: PassFields;
  [key: string]: unknown;
}

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
  severity: 'error' | 'warning';
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
  | { field: string | string[]; prop?: 'value' | 'attributedValue' | 'label' | 'changeMessage' }
  | { action: string; prop: 'url' | 'placeIdentifier' }
  | { barcode: number | '*'; prop: 'message' | 'altText' }
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
