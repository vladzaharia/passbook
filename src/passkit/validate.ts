import type {
  PassField,
  PassIdentity,
  PassJson,
  PassStyle,
  ValidationIssue,
  ValidationReport,
} from './types.ts';
import { PASS_STYLES } from './types.ts';

export interface ValidatableAsset {
  name: string;
  width?: number;
  height?: number;
}

export interface ValidatePassOptions {
  /** Treat warnings as errors. */
  strict?: boolean;
}

const KNOWN_KEYS = new Set([
  'formatVersion',
  'passTypeIdentifier',
  'teamIdentifier',
  'serialNumber',
  'organizationName',
  'description',
  'webServiceURL',
  'authenticationToken',
  'logoText',
  'foregroundColor',
  'backgroundColor',
  'labelColor',
  'stripColor',
  'barcode',
  'barcodes',
  'locations',
  'beacons',
  'relevantDate',
  'relevantDates',
  'maxDistance',
  'expirationDate',
  'voided',
  'sharingProhibited',
  'suppressStripShine',
  'userInfo',
  'featuredActions',
  'semantics',
  'nfc',
  'appLaunchURL',
  'associatedStoreIdentifiers',
  'groupingIdentifier',
  'preferredStyleSchemes',
  'sharingURL',
  'auxiliaryStoreIdentifiers',
  'eventLogoText',
  'footerBackgroundColor',
  'useAutomaticColor',
  'generic',
  'posterGeneric',
  'storeCard',
  'coupon',
  'eventTicket',
  'boardingPass',
  'transitType',
  'passInformation',
  'relevantLocationAltitude',
  'bagPolicyURL',
  'orderFoodURL',
  'parkingInformationURL',
  'purchaseParkingURL',
  'transitInformationURL',
  'directionsInformationURL',
  'contactVenuePhoneNumber',
  'contactVenueEmail',
  'contactVenueWebsite',
  'accessibilityURL',
  'merchandiseURL',
  'addOnURL',
  'upgradeURL',
  'changeSeatURL',
  'managementURL',
  'transferURL',
  'sellURL',
  'personalizationURL',
  'nameRequired',
  'tooling',
]);

const BARCODE_FORMATS = new Set([
  'PKBarcodeFormatQR',
  'PKBarcodeFormatPDF417',
  'PKBarcodeFormatAztec',
  'PKBarcodeFormatCode128',
]);
const COLOR = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const FIELD_GROUPS = [
  'headerFields',
  'primaryFields',
  'secondaryFields',
  'auxiliaryFields',
  'backFields',
  'additionalInfoFields',
] as const;
const FIELD_LIMITS: Record<string, number> = {
  headerFields: 3,
  primaryFields: 1,
  secondaryFields: 4,
  auxiliaryFields: 4,
};
const LINK_PROTOCOLS = new Set(['https:', 'tel:', 'mailto:']);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a built pass.json before signing. Errors block signing; warnings are surfaced to admins.
 * This is the foundation subset; the passkit agent extends it to the full catalog (src/passkit/schema).
 */
export function validatePass(
  pass: PassJson,
  assets: ValidatableAsset[],
  identity: PassIdentity,
  options: ValidatePassOptions = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const error = (code: string, message: string, path?: string) =>
    issues.push({ severity: 'error', code, message, ...(path ? { path } : {}) });
  const warn = (code: string, message: string, path?: string) =>
    issues.push({
      severity: options.strict ? 'error' : 'warning',
      code,
      message,
      ...(path ? { path } : {}),
    });

  if (pass.formatVersion !== 1)
    error('FORMAT_VERSION', 'formatVersion must be 1.', 'formatVersion');
  for (const key of [
    'passTypeIdentifier',
    'teamIdentifier',
    'serialNumber',
    'organizationName',
    'description',
  ] as const) {
    if (typeof pass[key] !== 'string' || pass[key] === '')
      error('REQUIRED', `${key} is required.`, key);
  }
  if (
    pass.passTypeIdentifier !== identity.passTypeIdentifier ||
    pass.teamIdentifier !== identity.teamIdentifier
  ) {
    error(
      'IDENTITY_MISMATCH',
      'Pass type or team does not match the signing identity.',
      'passTypeIdentifier',
    );
  }
  for (const key of Object.keys(pass)) {
    if (!KNOWN_KEYS.has(key)) warn('UNKNOWN_KEY', `Unknown key ${key}.`, key);
  }

  const styles = PASS_STYLES.filter((style) => isObject(pass[style]));
  if (styles.length === 0) error('NO_STYLE', 'The pass needs one style dictionary.');
  const seen = new Set<string>();
  for (const style of styles) validateStyle(style, pass, seen, error, warn);

  for (const key of [
    'foregroundColor',
    'backgroundColor',
    'labelColor',
    'stripColor',
    'footerBackgroundColor',
  ] as const) {
    const value = pass[key];
    if (value === undefined) continue;
    const m = typeof value === 'string' ? COLOR.exec(value) : null;
    if (!m || [m[1], m[2], m[3]].some((n) => Number(n) > 255))
      error('COLOR', `${key} must be rgb(r, g, b).`, key);
  }
  for (const key of ['relevantDate', 'expirationDate'] as const) {
    const value = pass[key];
    if (value !== undefined && (typeof value !== 'string' || !ISO_DATE.test(value)))
      error('DATE', `${key} must be ISO 8601.`, key);
  }
  if (Array.isArray(pass.barcodes)) {
    pass.barcodes.forEach((b, i) => {
      if (!isObject(b) || !BARCODE_FORMATS.has(String(b.format)))
        error('BARCODE_FORMAT', 'Unsupported barcode format.', `barcodes.${i}.format`);
      else if (typeof b.message !== 'string' || typeof b.messageEncoding !== 'string')
        error('BARCODE', 'Barcode needs message and messageEncoding.', `barcodes.${i}`);
    });
  }
  if (Array.isArray(pass.locations) && pass.locations.length > 10)
    error('LOCATIONS', 'At most 10 locations.', 'locations');
  if (pass.nfc !== undefined && !identity.nfcEnabled)
    error('NFC_NOT_ENTITLED', 'The signing identity is not NFC-enabled.', 'nfc');
  validateFeaturedActions(pass.featuredActions, error);
  if (!assets.some((a) => /^icon(?:@[23]x)?\.png$/.test(a.name)))
    error('MISSING_ICON', 'icon.png is required.');

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

type Report = (code: string, message: string, path?: string) => unknown;

function validateStyle(
  style: PassStyle,
  pass: PassJson,
  seen: Set<string>,
  error: Report,
  warn: Report,
): void {
  const dict = pass[style];
  if (!isObject(dict)) return;
  for (const group of FIELD_GROUPS) {
    const fields = dict[group];
    if (fields === undefined) continue;
    if (!Array.isArray(fields)) {
      error('FIELDS', `${group} must be an array.`, `${style}.${group}`);
      continue;
    }
    const limit = FIELD_LIMITS[group];
    if (limit !== undefined && fields.length > limit && style !== 'posterGeneric') {
      warn('FIELD_COUNT', `${group} has more than ${limit} fields.`, `${style}.${group}`);
    }
    (fields as PassField[]).forEach((field, i) => {
      const path = `${style}.${group}.${i}`;
      if (!isObject(field) || typeof field.key !== 'string' || field.key === '') {
        error('FIELD_KEY', 'Every field needs a key.', path);
        return;
      }
      if (seen.has(field.key))
        error('DUPLICATE_FIELD_KEY', `Field key ${field.key} is used more than once.`, path);
      seen.add(field.key);
      if (field.attributedValue !== undefined)
        checkLinks(String(field.attributedValue), error, path);
    });
  }
}

function checkLinks(html: string, error: Report, path: string): void {
  for (const match of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    try {
      if (!LINK_PROTOCOLS.has(new URL(match[1] ?? '').protocol))
        error('LINK', 'Links must use https, tel or mailto.', path);
    } catch {
      error('LINK', 'Invalid link.', path);
    }
  }
}

function validateFeaturedActions(actions: unknown, error: Report): void {
  if (actions === undefined) return;
  if (!Array.isArray(actions) || actions.length > 2) {
    error('FEATURED_ACTIONS', 'Wallet supports at most two featured actions.', 'featuredActions');
    return;
  }
  const ids = new Set<string>();
  for (const action of actions) {
    if (
      !isObject(action) ||
      typeof action.identifier !== 'string' ||
      !action.identifier ||
      ids.has(action.identifier)
    ) {
      error('FEATURED_ACTIONS', 'Featured actions need unique identifiers.', 'featuredActions');
      continue;
    }
    ids.add(action.identifier);
    if (action.type === 'place') {
      if (
        typeof action.placeIdentifier !== 'string' ||
        !/^I[0-9A-Fa-f]{1,16}$/.test(action.placeIdentifier)
      ) {
        error(
          'FEATURED_ACTIONS',
          'Place actions need an Apple Maps place identifier.',
          'featuredActions',
        );
      }
    } else if (typeof action.url !== 'string' || !/^(https:|tel:)/.test(action.url)) {
      error('FEATURED_ACTIONS', 'Featured actions need an https or tel URL.', 'featuredActions');
    }
  }
}
