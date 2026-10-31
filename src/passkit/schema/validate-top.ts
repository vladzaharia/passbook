import { PASS_STYLES, type PassJson } from '../types.ts';
import {
  AIRLINE_URL_KEYS,
  COLOR_KEYS,
  EVENT_URL_KEYS,
  PREFERRED_STYLE_SCHEMES,
  type StyleTag,
} from './constants.ts';
import {
  checkUrlValue,
  isObject,
  isRgb,
  parseIsoDate,
  parseUrl,
  type Report,
  type ValidationContext,
} from './util.ts';

type KeyType = 'string' | 'boolean' | 'url' | 'intArray' | 'any';
interface KeySpec {
  type: KeyType;
  /** The key is drawn only for these styles; elsewhere it warns. */
  styles?: StyleTag[];
}

const PET: StyleTag[] = ['PET'];
const SBP: StyleTag[] = ['SBP'];
const STRIP: StyleTag[] = ['coupon', 'storeCard', 'eventTicket'];

const KEY_SPECS: Record<string, KeySpec> = {
  webServiceURL: { type: 'url' },
  authenticationToken: { type: 'string' },
  logoText: { type: 'string' },
  eventLogoText: { type: 'string', styles: PET },
  logoSymbolName: { type: 'string' },
  groupingIdentifier: { type: 'string', styles: ['eventTicket', 'boardingPass'] },
  appLaunchURL: { type: 'string' },
  userInfo: { type: 'any' },
  voided: { type: 'boolean' },
  sharingProhibited: { type: 'boolean' },
  suppressStripShine: { type: 'boolean', styles: STRIP },
  useAutomaticColors: { type: 'boolean', styles: PET },
  suppressHeaderDarkening: { type: 'boolean', styles: ['PET', 'posterGeneric'] },
  associatedStoreIdentifiers: { type: 'intArray' },
  auxiliaryStoreIdentifiers: { type: 'intArray', styles: PET },
  businessChatIdentifier: { type: 'string', styles: SBP },
  ...Object.fromEntries(
    EVENT_URL_KEYS.map((k): [string, KeySpec] => [
      k,
      { type: 'any', styles: k === 'orderFoodURL' ? ['PET', 'SBP'] : PET },
    ]),
  ),
  ...Object.fromEntries(
    AIRLINE_URL_KEYS.map((k): [string, KeySpec] => [k, { type: 'any', styles: SBP }]),
  ),
  stripColor: { type: 'any', styles: STRIP },
  footerBackgroundColor: { type: 'any', styles: ['PET', 'posterGeneric'] },
};

/** Keys validated by their own rule modules. */
const HANDLED_KEYS = [
  'formatVersion',
  'passTypeIdentifier',
  'teamIdentifier',
  'serialNumber',
  'organizationName',
  'description',
  'foregroundColor',
  'backgroundColor',
  'labelColor',
  'barcode',
  'barcodes',
  'locations',
  'maxDistance',
  'beacons',
  'relevantDate',
  'relevantDates',
  'expirationDate',
  'sharing',
  'nfc',
  'semantics',
  'featuredActions',
  'upcomingPassInformation',
  'preferredStyleSchemes',
  ...PASS_STYLES,
];

const REQUIRED_STRINGS = [
  'passTypeIdentifier',
  'teamIdentifier',
  'serialNumber',
  'organizationName',
  'description',
] as const;

/** Style dictionaries present plus the PET / SBP variants selected by preferredStyleSchemes. */
export function resolveStyles(pass: PassJson, error: Report, warn: Report): Set<StyleTag> {
  const present = PASS_STYLES.filter((style) => isObject(pass[style]));
  for (const style of PASS_STYLES)
    if (pass[style] !== undefined && !isObject(pass[style]))
      error('STYLE_TYPE', `${style} must be an object.`, style);
  const styles = new Set<StyleTag>(present);
  if (present.length === 0) error('NO_STYLE', 'The pass needs one style dictionary.');
  const legacy = present.filter((s) => s !== 'posterGeneric');
  if (legacy.length > 1)
    error('MULTIPLE_STYLES', `Use one legacy style; found ${legacy.join(', ')}.`);
  if (present.includes('posterGeneric') && legacy.length === 0)
    error(
      'POSTER_FALLBACK',
      'posterGeneric needs a legacy style (for example generic) for iOS 26 and earlier.',
      'posterGeneric',
    );

  const schemes = pass.preferredStyleSchemes;
  if (schemes === undefined) return styles;
  if (!Array.isArray(schemes) || !schemes.every((s) => typeof s === 'string')) {
    error(
      'PREFERRED_SCHEMES',
      'preferredStyleSchemes must be an array of strings.',
      'preferredStyleSchemes',
    );
    return styles;
  }
  for (const scheme of schemes as string[]) {
    if (!(PREFERRED_STYLE_SCHEMES as readonly string[]).includes(scheme))
      warn('PREFERRED_SCHEMES', `Unknown style scheme ${scheme}.`, 'preferredStyleSchemes');
  }
  if (schemes.includes('posterEventTicket')) {
    if (!present.includes('eventTicket'))
      error(
        'PREFERRED_SCHEMES',
        'posterEventTicket needs an eventTicket dictionary.',
        'preferredStyleSchemes',
      );
    else {
      styles.add('PET');
      if (!schemes.includes('eventTicket'))
        warn(
          'PREFERRED_SCHEMES',
          'List eventTicket after posterEventTicket as the fallback.',
          'preferredStyleSchemes',
        );
    }
  }
  if (schemes.includes('semanticBoardingPass')) {
    const transit = pass.boardingPass?.transitType;
    if (!present.includes('boardingPass') || transit !== 'PKTransitTypeAir')
      error(
        'PREFERRED_SCHEMES',
        'semanticBoardingPass needs a boardingPass with PKTransitTypeAir.',
        'preferredStyleSchemes',
      );
    else {
      styles.add('SBP');
      if (!schemes.includes('boardingPass'))
        warn(
          'PREFERRED_SCHEMES',
          'List boardingPass after semanticBoardingPass as the fallback.',
          'preferredStyleSchemes',
        );
    }
  }
  return styles;
}

export function validateTopLevel(ctx: ValidationContext): void {
  const { pass, identity, error, warn } = ctx;
  if ((pass.formatVersion as unknown) !== 1)
    error('FORMAT_VERSION', 'formatVersion must be 1.', 'formatVersion');
  for (const key of REQUIRED_STRINGS)
    if (typeof pass[key] !== 'string' || pass[key] === '')
      error('REQUIRED', `${key} is required.`, key);
  if (typeof pass.passTypeIdentifier === 'string' && !pass.passTypeIdentifier.startsWith('pass.'))
    warn('PASS_TYPE_FORMAT', 'passTypeIdentifier should start with "pass.".', 'passTypeIdentifier');
  if (
    pass.passTypeIdentifier !== identity.passTypeIdentifier ||
    pass.teamIdentifier !== identity.teamIdentifier
  )
    error(
      'IDENTITY_MISMATCH',
      'Pass type or team does not match the signing identity.',
      'passTypeIdentifier',
    );

  for (const key of Object.keys(pass)) {
    if (key === '_id') continue;
    const spec = KEY_SPECS[key];
    if (!spec && !HANDLED_KEYS.includes(key)) {
      warn('UNKNOWN_KEY', `Unknown key ${key}.`, key);
      continue;
    }
    const value = pass[key];
    if (value === undefined) continue;
    if (spec) checkKey(ctx, key, value, spec);
  }

  for (const key of COLOR_KEYS)
    if (pass[key] !== undefined && !isRgb(pass[key]))
      error('COLOR', `${key} must be rgb(r, g, b).`, key);
  for (const key of ['relevantDate', 'expirationDate'] as const)
    if (pass[key] !== undefined && parseIsoDate(pass[key]) === undefined)
      error('DATE', `${key} must be ISO 8601 with hours, minutes and a time zone.`, key);

  if (
    pass.webServiceURL !== undefined &&
    (typeof pass.authenticationToken !== 'string' || pass.authenticationToken.length < 16)
  )
    error(
      'AUTH_TOKEN',
      'webServiceURL needs an authenticationToken of at least 16 characters.',
      'authenticationToken',
    );
  else if (typeof pass.authenticationToken === 'string' && pass.authenticationToken.length < 16)
    error('AUTH_TOKEN', 'authenticationToken needs at least 16 characters.', 'authenticationToken');
  if (pass.appLaunchURL !== undefined && !Array.isArray(pass.associatedStoreIdentifiers))
    warn('APP_LAUNCH_URL', 'appLaunchURL needs associatedStoreIdentifiers.', 'appLaunchURL');
  if (
    ctx.styles.has('PET') &&
    EVENT_URL_KEYS.filter((k) => k !== 'orderFoodURL' && pass[k] !== undefined).length === 1
  )
    warn('EVENT_GUIDE', 'The event guide needs at least two of its URL keys.', 'accessibilityURL');
}

function checkKey(ctx: ValidationContext, key: string, value: unknown, spec: KeySpec): void {
  const path = key;
  const { error, warn } = ctx;
  const isUrlKey =
    (EVENT_URL_KEYS as readonly string[]).includes(key) ||
    (AIRLINE_URL_KEYS as readonly string[]).includes(key);
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') error('KEY_TYPE', `${key} must be a string.`, path);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') error('KEY_TYPE', `${key} must be a boolean.`, path);
      break;
    case 'url': {
      const url = parseUrl(value);
      if (!url) error('URL', `${key} must be a valid URL.`, path);
      else if (url.protocol === 'http:')
        warn('URL_SCHEME', `${key} must be https outside developer mode.`, path);
      else if (url.protocol !== 'https:') error('URL', `${key} must be https.`, path);
      break;
    }
    case 'intArray':
      if (!Array.isArray(value) || !value.every((n) => Number.isInteger(n) && n >= 0))
        error('KEY_TYPE', `${key} must be an array of integers.`, path);
      break;
    default:
      // Colors are checked with the other color keys.
      if (isUrlKey) checkUrlValue(ctx, key, value, path);
  }
  if (spec.styles && !spec.styles.some((s) => ctx.styles.has(s)))
    warn('STYLE_MISMATCH', `${key} has no effect on this pass style.`, path);
}
